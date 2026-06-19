import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/computer-*.e2e.ts'],
    // Why: computer-use E2E files share the real desktop focus, clipboard, and
    // app windows. Parallel files can steal focus from each other.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
