import { describe, expect, it } from 'vitest'
import type {
  ClaudeUsageDailyPoint,
  ClaudeUsageScanState,
  ClaudeUsageSummary
} from '../../../../shared/claude-usage-types'
import type {
  CodexUsageDailyPoint,
  CodexUsageScanState,
  CodexUsageSummary
} from '../../../../shared/codex-usage-types'
import type {
  OpenCodeUsageDailyPoint,
  OpenCodeUsageScanState,
  OpenCodeUsageSummary
} from '../../../../shared/opencode-usage-types'
import {
  buildUsageOverview,
  formatUsageCost,
  formatUsageTokens,
  getRecentUsageDays
} from './usage-overview-model'

function enabledClaudeScanState(): ClaudeUsageScanState {
  return {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: 100,
    lastScanCompletedAt: 200,
    lastScanError: null,
    hasAnyClaudeData: true
  }
}

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

function enabledOpenCodeScanState(): OpenCodeUsageScanState {
  return {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: 500,
    lastScanCompletedAt: 600,
    lastScanError: null,
    hasAnyOpenCodeData: true
  }
}

describe('usage overview model', () => {
  it('combines provider totals without double-counting cached input', () => {
    const claudeSummary: ClaudeUsageSummary = {
      scope: 'orca',
      range: '30d',
      sessions: 2,
      turns: 4,
      zeroCacheReadTurns: 1,
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 500,
      cacheReuseRate: 0.8,
      estimatedCostUsd: 0.04,
      topModel: 'claude-sonnet-4-5',
      topProject: 'orca-main',
      hasAnyClaudeData: true
    }
    const codexSummary: CodexUsageSummary = {
      scope: 'orca',
      range: '30d',
      sessions: 1,
      events: 3,
      inputTokens: 2_000,
      cachedInputTokens: 800,
      outputTokens: 1_200,
      reasoningOutputTokens: 300,
      totalTokens: 3_200,
      estimatedCostUsd: 0.02,
      topModel: 'gpt-5.4',
      topProject: 'orca-secondary',
      hasAnyCodexData: true
    }
    const openCodeSummary: OpenCodeUsageSummary = {
      scope: 'orca',
      range: '30d',
      sessions: 1,
      events: 2,
      inputTokens: 1_000,
      cachedInputTokens: 250,
      outputTokens: 500,
      reasoningOutputTokens: 100,
      totalTokens: 1_600,
      estimatedCostUsd: 0.03,
      topModel: 'anthropic/claude-sonnet-4-5',
      topProject: 'orca-third',
      hasAnyOpenCodeData: true
    }
    const claudeDaily: ClaudeUsageDailyPoint[] = [
      {
        day: '2026-05-13',
        inputTokens: 500,
        outputTokens: 500,
        cacheReadTokens: 2_500,
        cacheWriteTokens: 0
      },
      {
        day: '2026-05-14',
        inputTokens: 500,
        outputTokens: 0,
        cacheReadTokens: 1_500,
        cacheWriteTokens: 500
      }
    ]
    const codexDaily: CodexUsageDailyPoint[] = [
      {
        day: '2026-05-14',
        inputTokens: 1_200,
        cachedInputTokens: 400,
        outputTokens: 800,
        reasoningOutputTokens: 100,
        totalTokens: 2_000
      },
      {
        day: '2026-05-15',
        inputTokens: 800,
        cachedInputTokens: 400,
        outputTokens: 400,
        reasoningOutputTokens: 200,
        totalTokens: 1_200
      }
    ]
    const openCodeDaily: OpenCodeUsageDailyPoint[] = [
      {
        day: '2026-05-15',
        inputTokens: 1_000,
        cachedInputTokens: 250,
        outputTokens: 500,
        reasoningOutputTokens: 100,
        totalTokens: 1_600
      }
    ]

    const overview = buildUsageOverview({
      claude: {
        scanState: enabledClaudeScanState(),
        summary: claudeSummary,
        daily: claudeDaily
      },
      codex: {
        scanState: enabledCodexScanState(),
        summary: codexSummary,
        daily: codexDaily
      },
      opencode: {
        scanState: enabledOpenCodeScanState(),
        summary: openCodeSummary,
        daily: openCodeDaily
      }
    })

    expect(overview.totalTokens).toBe(10_800)
    expect(overview.newInputTokens).toBe(2_950)
    expect(overview.cacheTokens).toBe(5_550)
    expect(overview.outputTokens).toBe(2_200)
    expect(overview.reasoningTokens).toBe(400)
    expect(overview.sessions).toBe(4)
    expect(overview.activityCount).toBe(9)
    expect(overview.activeDays).toBe(3)
    expect(overview.estimatedCostUsd).toBeCloseTo(0.09)
    expect(overview.cacheShare).toBeCloseTo(5_550 / 8_500)
    expect(overview.bestDay).toMatchObject({
      day: '2026-05-14',
      totalTokens: 4_500,
      claudeTokens: 2_500,
      codexTokens: 2_000,
      openCodeTokens: 0,
      intensity: 4
    })
    expect(overview.providers.find((provider) => provider.id === 'codex')).toMatchObject({
      newInputTokens: 1_200,
      cacheTokens: 800,
      totalTokens: 3_200
    })
    expect(overview.providers.find((provider) => provider.id === 'opencode')).toMatchObject({
      newInputTokens: 750,
      cacheTokens: 250,
      totalTokens: 1_600
    })
  })

  it('pads recent usage days with zero-token cells', () => {
    const recent = getRecentUsageDays(
      [
        {
          day: '2026-05-14',
          totalTokens: 4_500,
          claudeTokens: 2_500,
          codexTokens: 2_000,
          openCodeTokens: 0,
          intensity: 4
        }
      ],
      3,
      new Date('2026-05-15T12:00:00')
    )

    expect(recent).toEqual([
      {
        day: '2026-05-13',
        totalTokens: 0,
        claudeTokens: 0,
        codexTokens: 0,
        openCodeTokens: 0,
        intensity: 0
      },
      {
        day: '2026-05-14',
        totalTokens: 4_500,
        claudeTokens: 2_500,
        codexTokens: 2_000,
        openCodeTokens: 0,
        intensity: 4
      },
      {
        day: '2026-05-15',
        totalTokens: 0,
        claudeTokens: 0,
        codexTokens: 0,
        openCodeTokens: 0,
        intensity: 0
      }
    ])
  })

  it('reports disabled providers as an empty overview', () => {
    const overview = buildUsageOverview({
      claude: { scanState: null, summary: null, daily: [] },
      codex: { scanState: null, summary: null, daily: [] },
      opencode: { scanState: null, summary: null, daily: [] }
    })

    expect(overview.hasAnyEnabledProvider).toBe(false)
    expect(overview.hasAnyData).toBe(false)
    expect(overview.totalTokens).toBe(0)
    expect(overview.estimatedCostUsd).toBeNull()
    expect(overview.cacheShare).toBeNull()
  })

  it('formats token and cost values for compact UI labels', () => {
    expect(formatUsageTokens(999)).toBe('999')
    expect(formatUsageTokens(1_200)).toBe('1.2k')
    expect(formatUsageTokens(2_500_000)).toBe('2.5M')
    expect(formatUsageCost(null)).toBe('n/a')
    expect(formatUsageCost(0.0042)).toBe('$0.0042')
    expect(formatUsageCost(1.234)).toBe('$1.23')
  })
})
