import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// Like the core, the reader is pure: it runs in Node, in a worker or in a test, and the
// caller owns the camera, the clock and the screen.
const FORBIDDEN = /\b(document|window|navigator|performance|Date\.now|new Date|requestAnimationFrame|setTimeout|setInterval|localStorage)\b/;

describe('head reader invariants', () => {
  it.each(files)('%s uses no browser globals or wall-clock time', (file) => {
    expect(code(readFileSync(SRC + file, 'utf8'))).not.toMatch(FORBIDDEN);
  });

  it('imports nothing but the core', () => {
    for (const file of files) {
      const imports = [...readFileSync(SRC + file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      expect(imports.filter((i) => !i.startsWith('./') && i !== 'gesturecore'), file).toEqual([]);
    }
  });
});
