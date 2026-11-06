import { describe, expect, it } from 'vitest'

import type {
  CodexUsageDailyPoint,
  CodexUsageScanState
} from '../../../../shared/codex-usage-types'

import { buildUsageOverview } from './usage-overview-model'

function enabledCodexScanState(): CodexUsageScanState {
  return {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: 300,
    lastScanCompletedAt: 400,
    lastScanError: null,
    hasAnyCodexData: true
  }
}

describe('usage overview model', () => {
  it('aggregates very large daily histories without spreading every day into Math.max', () => {
    const codexDaily: CodexUsageDailyPoint[] = Array.from({ length: 130_000 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, 1 + index))
      return {
        day: date.toISOString().slice(0, 10),
        inputTokens: index + 1,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: index + 1
      }
    })

    const overview = buildUsageOverview({
      claude: { scanState: null, summary: null, daily: [] },
      codex: {
        scanState: enabledCodexScanState(),
        summary: null,
        daily: codexDaily
      },
      opencode: { scanState: null, summary: null, daily: [] },
      muse: { scanState: null, summary: null, daily: [] }
    })

    expect(overview.daily).toHaveLength(130_000)
    expect(overview.bestDay?.totalTokens).toBe(130_000)
    expect(overview.daily.at(-1)?.intensity).toBe(4)
  })
})
