import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'sound',
    // The planner is pure, so it is tested without a browser or an audio device.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
