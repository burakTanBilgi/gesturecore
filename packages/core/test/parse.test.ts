import { describe, expect, it } from 'vitest';
import { parsePoses } from '../src/poses/parse.js';
import { FIST } from '../src/poses/defaults.js';

/**
 * `parsePoses` is the boundary between a file someone else wrote and this library's
 * config. Everything here is written from the attacker's side: what a hostile or
 * careless pose file could try, and what has to come back instead.
 */

const one = (pose: unknown) => parsePoses([pose]);

describe('parsePoses: what it accepts', () => {
  it('accepts the poses this library ships, unchanged', () => {
    const { poses, problems } = parsePoses(JSON.parse(JSON.stringify([FIST])) as unknown);
    expect(problems).toEqual([]);
    expect(poses).toEqual([FIST]);
  });

  it('accepts a minimal pose and leaves minScore off rather than inventing one', () => {
    const { poses, problems } = one({ name: 'wave-hello', fingers: { index: { curl: [0, 0.25] } } });
    expect(problems).toEqual([]);
    expect(poses[0]).toEqual({ name: 'wave-hello', fingers: { index: { curl: [0, 0.25] } } });
    expect('minScore' in poses[0]!).toBe(false);
  });

  it('accepts a finger with no curl: an empty constraint is not an error', () => {
    expect(one({ name: 'any', fingers: { thumb: {} } }).problems).toEqual([]);
  });

  it('returns a fresh object graph, so editing the result cannot reach the input', () => {
    const input = { name: 'p', fingers: { index: { curl: [0, 1] } } };
    const { poses } = one(input);
    poses[0]!.fingers.index!.curl![0] = 0.5;
    expect(input.fingers.index.curl[0]).toBe(0);
  });
});

describe('parsePoses: what it refuses', () => {
  it('refuses anything that is not an array of objects', () => {
    for (const bad of [null, undefined, 42, 'poses', { poses: [] }, [1], [null], [[]]]) {
      const { poses, problems } = parsePoses(bad);
      expect(poses).toEqual([]);
      expect(problems.length).toBeGreaterThan(0);
    }
  });

  it('refuses unknown keys rather than ignoring them', () => {
    const { poses, problems } = one({ name: 'p', fingers: {}, onLoad: 'alert(1)' });
    expect(poses).toEqual([]);
    expect(problems.join(' ')).toContain('onLoad');
  });

  it('refuses a name that could be read as markup or a selector', () => {
    for (const name of ['<img src=x onerror=alert(1)>', 'a"b', "a'b", 'a<b', 'a\u0000b', 'a\nb']) {
      expect(one({ name, fingers: {} }).poses).toEqual([]);
    }
  });

  it('refuses an empty name, and one long enough to break a layout', () => {
    expect(one({ name: '', fingers: {} }).poses).toEqual([]);
    expect(one({ name: 'x'.repeat(41), fingers: {} }).poses).toEqual([]);
  });

  it('refuses a finger this library does not have', () => {
    const { poses, problems } = one({ name: 'p', fingers: { toe: { curl: [0, 1] } } });
    expect(poses).toEqual([]);
    expect(problems.join(' ')).toContain('toe');
  });

  it('refuses curl values that are not two ordered numbers in 0..1', () => {
    for (const curl of [[0], [0, 1, 2], ['0', '1'], [1, 0], [-0.1, 1], [0, 1.1], [NaN, 1], [0, Infinity], null, {}]) {
      expect(one({ name: 'p', fingers: { index: { curl } } }).poses).toEqual([]);
    }
  });

  it('refuses a minScore outside 0..1 or not a number', () => {
    for (const minScore of [-0.1, 1.1, NaN, '0.8', null]) {
      expect(one({ name: 'p', fingers: {}, minScore }).poses).toEqual([]);
    }
  });

  it('refuses a file with more poses than anyone would read before installing', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ name: `p${i}`, fingers: {} }));
    const { poses, problems } = parsePoses(many);
    expect(poses).toEqual([]);
    expect(problems.join(' ')).toContain('65');
  });

  it('refuses duplicate names inside one file', () => {
    const { poses, problems } = parsePoses([
      { name: 'same', fingers: {} },
      { name: 'same', fingers: {} },
    ]);
    expect(poses).toEqual([]);
    expect(problems.join(' ')).toContain('same');
  });

  it('keeps the good poses when only some are bad, and says which failed', () => {
    const { poses, problems } = parsePoses([
      { name: 'good', fingers: { index: { curl: [0, 0.2] } } },
      { name: 'bad', fingers: { index: { curl: 'everything' } } },
    ]);
    expect(poses.map((p) => p.name)).toEqual(['good']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('bad');
  });
});

describe('parsePoses: prototype pollution', () => {
  it('does not let a pose file reach Object.prototype', () => {
    parsePoses(JSON.parse('[{"name":"p","fingers":{},"__proto__":{"polluted":"yes"}}]') as unknown);
    parsePoses(JSON.parse('{"__proto__":{"polluted":"yes"}}') as unknown);
    parsePoses(JSON.parse('[{"name":"p","fingers":{"__proto__":{"curl":[0,1]}}}]') as unknown);
    expect(({} as Record<string, unknown>)['polluted']).toBe(undefined);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('refuses a pose carrying __proto__, constructor or prototype as a key', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const pose = JSON.parse(`{"name":"p","fingers":{},"${key}":{}}`) as unknown;
      expect(parsePoses([pose]).poses).toEqual([]);
    }
  });

  it('a parsed pose has a normal prototype and no inherited surprises', () => {
    const { poses } = one({ name: 'p', fingers: { index: { curl: [0, 1] } } });
    expect(Object.getPrototypeOf(poses[0]!)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(poses[0]))).toEqual(poses[0]);
  });
});
