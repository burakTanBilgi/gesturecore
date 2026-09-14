import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Core tests must run with no browser environment. If a test needs jsdom,
    // the module under test has leaked.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
