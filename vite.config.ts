import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const FIXTURES = here('./packages/core/test/fixtures/');
const source = (pkg: string) => here(`./packages/${pkg}/src/index.ts`);
const require = createRequire(import.meta.url);
/** Semver of the project (root) and of each package, for the bench's header badge. */
const versionOf = (manifest: string) => (JSON.parse(readFileSync(here(manifest), 'utf8')) as { version: string }).version;
const versions = {
  project: versionOf('./package.json'),
  core: versionOf('./packages/core/package.json'),
  sound: versionOf('./packages/sound/package.json'),
};

/**
 * The site-wide security headers live in vercel.json. `vite preview` serves the same
 * ones, so a local production build is tested under the policy it will ship with.
 */
function siteHeaders(): Record<string, string> {
  const cfg = JSON.parse(readFileSync(here('./vercel.json'), 'utf8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  const all = cfg.headers.find((h) => h.source === '/(.*)')?.headers ?? [];
  return Object.fromEntries(all.map((h) => [h.key, h.value]));
}

/**
 * Which build this is, shown in the bench header so a preview is never mistaken for
 * the real site. Vercel sets VERCEL_ENV and the branch name at build time.
 */
function benchEnv(command: 'serve' | 'build'): { env: string; ref: string } {
  if (command === 'serve') return { env: 'development', ref: '' };
  return { env: process.env.VERCEL_ENV ?? 'local', ref: process.env.VERCEL_GIT_COMMIT_REF ?? '' };
}

/**
 * The built site hosts MediaPipe itself rather than leaning on a CDN: the WebAssembly
 * runtime (the SIMD build and the fallback for older browsers) and the hand model.
 * The dev server reads both straight from disk instead.
 */
function hostMediapipe(): Plugin {
  const wasmDir = here('./node_modules/@mediapipe/tasks-vision/wasm/');
  const model = here('./bench/models/hand_landmarker.task');
  return {
    name: 'gesturecore-host-mediapipe',
    apply: 'build',
    generateBundle() {
      if (!existsSync(model)) this.error('bench/models/hand_landmarker.task is missing: run `npm run fetch-model` first');
      for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/wasm/${f}`, source: readFileSync(wasmDir + f) });
      }
      this.emitFile({ type: 'asset', fileName: 'bench/models/hand_landmarker.task', source: readFileSync(model) });
    },
  };
}

/**
 * dockview-core 8 ships its stylesheet only inside the UMD bundle (as an injected
 * string); the ES module build has none. This serves that CSS as
 * `virtual:dockview.css`, minus the bundled themes the bench does not use.
 */
function dockviewCss(): Plugin {
  const ID = 'virtual:dockview.css';
  return {
    name: 'gesturecore-dockview-css',
    resolveId: (id) => (id === ID ? `\0${ID}` : undefined),
    load(id) {
      if (id !== `\0${ID}`) return undefined;
      const umd = readFileSync(createRequire(import.meta.url).resolve('dockview-core/dist/dockview-core.js'), 'utf8');
      const marker = 's.textContent = "';
      const start = umd.indexOf(marker) + marker.length;
      if (start < marker.length) throw new Error('dockview CSS not found in dockview-core.js');
      let end = start;
      while (!(umd[end] === '"' && umd[end - 1] !== '\\')) end++;
      const css = JSON.parse(`"${umd.slice(start, end).replace(/\\'/g, "'")}"`) as string;
      return stripThemes(css);
    },
  };
}

/**
 * @mediapipe/tasks-vision 1.0.1 points at a source map it does not ship, so every
 * start printed a scary ENOENT stack. Serve the bundle without that pointer.
 */
function quietMediapipeSourcemap(): Plugin {
  return {
    name: 'gesturecore-quiet-mediapipe-sourcemap',
    enforce: 'pre',
    load(id) {
      const file = id.split('?')[0]!;
      if (!/[\\/]@mediapipe[\\/]tasks-vision[\\/]vision_bundle\.mjs$/.test(file)) return undefined;
      return readFileSync(file, 'utf8').replace(/\/\/# sourceMappingURL=\S+\s*$/, '');
    },
  };
}

/** Drops top-level rules whose selector names a bundled `.dockview-theme-*`. */
function stripThemes(css: string): string {
  let out = '';
  let depth = 0;
  let ruleStart = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) {
      const rule = css.slice(ruleStart, i + 1);
      const selector = rule.slice(0, rule.indexOf('{'));
      if (!selector.includes('.dockview-theme-')) out += rule;
      ruleStart = i + 1;
    }
  }
  return out;
}

/**
 * Dev-only endpoint so the bench can write a captured fixture straight into
 * test/fixtures/<name>.json. Accepts only a 21-point array of finite numbers.
 */
function saveFixtures(): Plugin {
  return {
    name: 'gesturecore-save-fixture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__fixtures', (req, res) => {
        const name = (req.url ?? '').replace(/^\//, '');
        if (req.method !== 'POST' || !/^[a-z][a-z0-9-]{0,40}$/.test(name)) {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }
        // This endpoint writes into the project, so only the bench itself may call it.
        // Any other web page open in the same browser could otherwise post here: reject
        // cross-site requests, and require a JSON content type, which a foreign page
        // cannot send without a CORS preflight this server never grants.
        const site = req.headers['sec-fetch-site'];
        const origin = req.headers.origin;
        const sameOrigin = origin === undefined || /^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(origin);
        const json = (req.headers['content-type'] ?? '').startsWith('application/json');
        if ((site !== undefined && site !== 'same-origin') || !sameOrigin || !json) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 100_000) req.destroy();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as unknown;
            const points = (pts: unknown) =>
              Array.isArray(pts) &&
              pts.length === 21 &&
              pts.every(
                (p) =>
                  p !== null &&
                  typeof p === 'object' &&
                  Object.keys(p).sort().join() === 'x,y,z' &&
                  ['x', 'y', 'z'].every((k) => Number.isFinite((p as Record<string, unknown>)[k])),
              );
            // Either the original bare 21 points, or a set of views of one shape.
            const views = (d: unknown): boolean => {
              if (typeof d !== 'object' || d === null || !Array.isArray((d as { views?: unknown }).views)) return false;
              const list = (d as { views: unknown[] }).views;
              return (
                list.length > 0 &&
                list.every(
                  (v) =>
                    typeof v === 'object' &&
                    v !== null &&
                    typeof (v as { view?: unknown }).view === 'string' &&
                    points((v as { landmarks?: unknown }).landmarks),
                )
              );
            };
            if (!points(data) && !views(data)) throw new Error('expected 21 {x,y,z} points, or {views: [{view, landmarks}]}');
            writeFileSync(`${FIXTURES}${name}.json`, JSON.stringify(data, null, 2) + '\n');
            res.end(`saved test/fixtures/${name}.json`);
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [dockviewCss(), quietMediapipeSourcemap(), saveFixtures(), hostMediapipe()],
  define: {
    __BENCH_ENV__: JSON.stringify(benchEnv(command).env),
    __BENCH_REF__: JSON.stringify(benchEnv(command).ref),
    __BENCH_VERSION__: JSON.stringify(versions.project),
    __CORE_VERSION__: JSON.stringify(versions.core),
    __SOUND_VERSION__: JSON.stringify(versions.sound),
  },
  // The published site: the redirecting root page and the bench.
  build: {
    outDir: 'site',
    emptyOutDir: true,
    rollupOptions: { input: { index: here('./index.html'), bench: here('./bench/index.html') } },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, headers: siteHeaders() },
  // The bench runs the packages from source, so edits show up without a build.
  resolve: {
    alias: [
      { find: /^gesturecore$/, replacement: source('core') },
      { find: /^gesturecore-sound$/, replacement: source('sound') },
    ],
  },
  // The bench's only two libraries already ship as plain ES modules, so they are served
  // as they are. Pre-bundling them gave each server run a new version tag, and a page
  // that loaded before the rebuild finished asked for a tag that no longer existed
  // ("Failed to fetch dynamically imported module").
  optimizeDeps: { noDiscovery: true, include: [], exclude: ['@mediapipe/tasks-vision', 'dockview-core'] },
  server: {
    // An explicit IPv4 address: plain `localhost` can bind to ::1 only, which some
    // browser setups never try. 127.0.0.1 still counts as secure for camera access.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // `npm run bench` opens the bench itself (set BROWSER to pick which browser);
    // the root page only forwards there.
    open: process.env.BENCH_NO_OPEN ? false : '/bench/',
  },
}));
