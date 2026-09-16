import { defineConfig } from 'vitest/config';

// Each package keeps its own test setup; this runs them all.
export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
