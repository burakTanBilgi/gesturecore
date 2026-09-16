import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const FIXTURES = fileURLToPath(new URL('./test/fixtures/', import.meta.url));

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

export default defineConfig({
  plugins: [dockviewCss(), saveFixtures()],
  server: { port: 5173, strictPort: true },
});
