import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Strip comments so documentation may mention forbidden names. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const FORBIDDEN: [string, RegExp][] = [
  ['document', /\bdocument\b/],
  ['window', /\bwindow\b/],
  ['navigator', /\bnavigator\b/],
  ['performance', /\bperformance\b/],
  ['Date.now', /\bDate\.now\b/],
  ['new Date', /\bnew Date\b/],
  ['requestAnimationFrame', /\brequestAnimationFrame\b/],
  ['AudioContext', /\bAudioContext\b/],
  ['localStorage', /\blocalStorage\b/],
  ['setTimeout', /\bsetTimeout\b/],
  ['setInterval', /\bsetInterval\b/],
];

const files = walk(SRC).filter((f) => f.endsWith('.ts'));

describe('core invariants', () => {
  it('src/ is not empty', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(SRC, f), f]))('%s uses no browser globals or wall-clock time', (_, file) => {
    const text = code(readFileSync(file, 'utf8'));
    const hits = FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => name);
    expect(hits).toEqual([]);
  });

  it('src/ contains zero references to document, window or navigator, even in comments', () => {
    // Definition of done is literal: zero references anywhere in src/.
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, relative(SRC, file)).not.toMatch(/\b(document|window|navigator)\b/);
    }
  });
});
