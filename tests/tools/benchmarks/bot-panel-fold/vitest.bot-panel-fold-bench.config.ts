import { defineConfig } from 'vitest/config'
import baseConfig from '../../../../config/vitest.config'

// Bot panel fold bench; never part of a test run. Usage:
//   pnpm exec vitest run --config tests/tools/benchmarks/bot-panel-fold/vitest.bot-panel-fold-bench.config.ts
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    projects: undefined,
    include: ['tests/tools/benchmarks/bot-panel-fold/bot-panel-fold-benchmark.test.tsx'],
    benchmark: { include: [] },
    fileParallelism: false,
    retry: 0
  }
})
