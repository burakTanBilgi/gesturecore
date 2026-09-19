import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The reader calls into the core at runtime; test against its source, not a build.
  resolve: { alias: [{ find: /^gesturecore$/, replacement: fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) }] },
  test: {
    name: 'head',
    // Pure geometry and timers: no browser, no camera.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
