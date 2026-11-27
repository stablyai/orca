import { defineConfig } from 'vitest/config'
import baseConfig from '../../../../config/vitest.config'

// Bots chat-tree notice bench; never part of a test run. Driven by bot-chat-tree-bench.mjs beside it.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    projects: undefined,
    include: ['tests/tools/benchmarks/bot-chat-tree/bot-chat-tree-notices-benchmark.ts'],
    benchmark: { include: [] },
    fileParallelism: false,
    retry: 0,
    testTimeout: 1_800_000
  }
})
