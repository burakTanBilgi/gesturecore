import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const FIXTURES = fileURLToPath(new URL('./test/fixtures/', import.meta.url));

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
            const pts = JSON.parse(body) as unknown;
            const ok =
              Array.isArray(pts) &&
              pts.length === 21 &&
              pts.every(
                (p) =>
                  p !== null &&
                  typeof p === 'object' &&
                  Object.keys(p).sort().join() === 'x,y,z' &&
                  ['x', 'y', 'z'].every((k) => Number.isFinite((p as Record<string, unknown>)[k])),
              );
            if (!ok) throw new Error('expected 21 {x,y,z} points');
            writeFileSync(`${FIXTURES}${name}.json`, JSON.stringify(pts, null, 2) + '\n');
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
  plugins: [saveFixtures()],
  server: { port: 5173, strictPort: true },
});
