import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/computer-*.e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
