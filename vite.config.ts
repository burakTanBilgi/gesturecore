import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const FIXTURES = here('./packages/core/test/fixtures/');
// Saved bench workspaces. In the project for now; the bench treats this as one storage
// backend behind an interface, so a deployed bench can swap it for another.
const WORKSPACES = here('./bench/workspaces/');
// Pose packs on disk. Unlike workspaces these are meant to be shared and committed:
// a pose is declarative data, so a pack is something you can read in full before you
// install it. Everything read from here goes through `parsePoses` before it is used.
const POSES = here('./bench/poses/');
const source = (pkg: string) => here(`./packages/${pkg}/src/index.ts`);
const require = createRequire(import.meta.url);
/** Semver of the project (root) and of each package, for the bench's header badge. */
const versionOf = (manifest: string) => (JSON.parse(readFileSync(here(manifest), 'utf8')) as { version: string }).version;
const versions = {
  project: versionOf('./package.json'),
  core: versionOf('./packages/core/package.json'),
  sound: versionOf('./packages/sound/package.json'),
  head: versionOf('./packages/head/package.json'),
  chords: versionOf('./packages/chords/package.json'),
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
 * runtime (the SIMD build and the fallback for older browsers), the hand model and
 * the face model. The dev server reads them straight from disk instead.
 */
function hostMediapipe(): Plugin {
  const wasmDir = here('./node_modules/@mediapipe/tasks-vision/wasm/');
  const models = ['hand_landmarker.task', 'face_landmarker.task'];
  return {
    name: 'gesturecore-host-mediapipe',
    apply: 'build',
    generateBundle() {
      for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/wasm/${f}`, source: readFileSync(wasmDir + f) });
      }
      for (const m of models) {
        const file = here(`./bench/models/${m}`);
        if (!existsSync(file)) this.error(`bench/models/${m} is missing: run \`npm run fetch-model\` first`);
        this.emitFile({ type: 'asset', fileName: `bench/models/${m}`, source: readFileSync(file) });
      }
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


/**
 * Only the bench itself may reach an endpoint that writes into the project. A foreign
 * page open in the same browser could otherwise post here, so: reject anything that is
 * not same-origin, and require a JSON content type, which a cross-site page cannot send
 * without a CORS preflight this server never grants. Unlike the fixtures endpoint this
 * does not pin a port — the bench moves to 5174 when 5173 is taken, and a guard that
 * silently rejects the real port is worse than no guard, because it looks like a bug.
 */
function fromTheBench(req: { method?: string; headers: Record<string, unknown> }, needsJson: boolean): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  const origin = req.headers.origin as string | undefined;
  if (origin !== undefined && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return false;
  const type = String(req.headers['content-type'] ?? '');
  return !needsJson || type.startsWith('application/json');
}

/**
 * A folder of JSON files on disk, served to the bench: list, read, write, delete.
 * Dev only — `apply: 'serve'` — and guarded by `fromTheBench`.
 *
 * Workspaces and poses are the same endpoint with a different folder, so they share one
 * implementation: two copies of a security-sensitive handler drift, and the one that
 * drifts is the one nobody is looking at.
 */
function jsonFolder(opts: { route: string; dir: string; label: string; isArray: boolean }): Plugin {
  return {
    name: `gesturecore-${opts.label}`,
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(opts.route, (req, res) => {
        const name = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0] ?? '');
        const ok = (body: string) => {
          res.setHeader('content-type', 'application/json');
          res.end(body);
        };
        const fail = (code: number, why: string) => {
          res.statusCode = code;
          res.end(why);
        };
        const method = req.method ?? 'GET';

        if (!fromTheBench(req as never, method === 'POST')) return fail(403, 'forbidden');
        mkdirSync(opts.dir, { recursive: true });

        // A name becomes a filename, so it is checked rather than escaped.
        const named = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,39}$/.test(name);

        if (method === 'GET' && name === '') {
          const list = readdirSync(opts.dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5));
          return ok(JSON.stringify(list));
        }
        if (!named) return fail(400, 'bad name');
        const file = `${opts.dir}${name}.json`;

        if (method === 'GET') {
          if (!existsSync(file)) return fail(404, `no such ${opts.label}`);
          return ok(readFileSync(file, 'utf8'));
        }
        if (method === 'DELETE') {
          rmSync(file, { force: true });
          return ok('{"ok":true}');
        }
        if (method !== 'POST') return fail(405, 'method not allowed');

        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 400_000) req.destroy();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as unknown;
            // Shape only. What a pose file may actually contain is decided by
            // `parsePoses` in the core, on the way in as well as on the way out.
            const shaped = opts.isArray
              ? Array.isArray(data)
              : typeof data === 'object' && data !== null && !Array.isArray(data);
            if (!shaped) throw new Error(`expected a JSON ${opts.isArray ? 'array' : 'object'}`);
            writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
            ok(JSON.stringify({ saved: `bench/${opts.dir.split('/bench/')[1] ?? ''}${name}.json` }));
          } catch (err) {
            fail(400, String(err));
          }
        });
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    dockviewCss(),
    quietMediapipeSourcemap(),
    saveFixtures(),
    jsonFolder({ route: '/__workspaces', dir: WORKSPACES, label: 'workspaces', isArray: false }),
    jsonFolder({ route: '/__poses', dir: POSES, label: 'poses', isArray: true }),
    hostMediapipe(),
  ],
  define: {
    __BENCH_ENV__: JSON.stringify(benchEnv(command).env),
    __BENCH_REF__: JSON.stringify(benchEnv(command).ref),
    __BENCH_VERSION__: JSON.stringify(versions.project),
    __CORE_VERSION__: JSON.stringify(versions.core),
    __SOUND_VERSION__: JSON.stringify(versions.sound),
    __HEAD_VERSION__: JSON.stringify(versions.head),
    __CHORDS_VERSION__: JSON.stringify(versions.chords),
  },
  // The published site: the redirecting root page, the bench and the manual. The manual
  // is its own page rather than a dock panel — a reference document should not compete
  // for space with live instruments, and keeping it out halves the bench's markup.
  build: {
    outDir: 'site',
    emptyOutDir: true,
    rollupOptions: {
      input: { index: here('./index.html'), bench: here('./bench/index.html'), docs: here('./bench/docs.html') },
    },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, headers: siteHeaders() },
  // The bench runs the packages from source, so edits show up without a build.
  resolve: {
    alias: [
      { find: /^gesturecore$/, replacement: source('core') },
      { find: /^gesturecore-sound$/, replacement: source('sound') },
      { find: /^gesturecore-head$/, replacement: source('head') },
      { find: /^gesturecore-chords$/, replacement: source('chords') },
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
