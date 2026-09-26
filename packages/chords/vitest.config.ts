import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'chords',
    // Every chord decision is plain data, so none of this needs a browser.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
