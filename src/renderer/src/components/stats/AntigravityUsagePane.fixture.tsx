import type { AntigravityUsageSnapshot } from '../../../../shared/agent-usage/analytics/antigravity-usage-types'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { AntigravityUsagePane } from './AntigravityUsagePane'
import { StatsPane } from './StatsPane'

const SAMPLE_UPDATED_AT = 1_795_737_600_000

const POPULATED_SNAPSHOT: AntigravityUsageSnapshot = {
  scanState: {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: SAMPLE_UPDATED_AT - 1_200,
    lastScanCompletedAt: SAMPLE_UPDATED_AT,
    lastScanError: null,
    hasAnyAntigravityData: true
  },
  summary: {
    scope: 'orca',
    range: '30d',
    sessions: 14,
    events: 128,
    inputTokens: 1_842_000,
    cachedInputTokens: 1_490_000,
    outputTokens: 64_500,
    reasoningOutputTokens: 12_400,
    totalTokens: 1_906_500,
    topModel: 'gemini-4-carbon-high',
    topProject: 'orca',
    hasAnyAntigravityData: true
  },
  daily: [
    {
      day: '2026-11-24',
      inputTokens: 520_000,
      cachedInputTokens: 410_000,
      outputTokens: 19_200,
      reasoningOutputTokens: 3_800,
      totalTokens: 539_200
    },
    {
      day: '2026-11-25',
      inputTokens: 610_000,
      cachedInputTokens: 505_000,
      outputTokens: 21_800,
      reasoningOutputTokens: 4_100,
      totalTokens: 631_800
    },
    {
      day: '2026-11-26',
      inputTokens: 712_000,
      cachedInputTokens: 575_000,
      outputTokens: 23_500,
      reasoningOutputTokens: 4_500,
      totalTokens: 735_500
    }
  ],
  modelBreakdown: [
    {
      key: 'gemini-4-carbon-high',
      label: 'gemini-4-carbon-high',
      sessions: 10,
      events: 96,
      inputTokens: 1_410_000,
      cachedInputTokens: 1_160_000,
      outputTokens: 49_000,
      reasoningOutputTokens: 9_800,
      totalTokens: 1_459_000
    },
    {
      key: 'gemini-4-hydrogen-tiered-high',
      label: 'gemini-4-hydrogen-tiered-high',
      sessions: 4,
      events: 32,
      inputTokens: 432_000,
      cachedInputTokens: 330_000,
      outputTokens: 15_500,
      reasoningOutputTokens: 2_600,
      totalTokens: 447_500
    }
  ],
  projectBreakdown: [
    {
      key: 'worktree:wt-orca',
      label: 'orca',
      sessions: 11,
      events: 104,
      inputTokens: 1_560_000,
      cachedInputTokens: 1_280_000,
      outputTokens: 54_000,
      reasoningOutputTokens: 10_200,
      totalTokens: 1_614_000
    },
    {
      key: 'worktree:wt-docs',
      label: 'orca-docs',
      sessions: 3,
      events: 24,
      inputTokens: 282_000,
      cachedInputTokens: 210_000,
      outputTokens: 10_500,
      reasoningOutputTokens: 2_200,
      totalTokens: 292_500
    }
  ],
  recentSessions: [
    {
      sessionId: '9c186f90-1a4e-4d75-a878-eab782794d5c',
      lastActiveAt: '2026-11-26T23:36:02.000Z',
      durationMinutes: 18,
      projectLabel: 'orca',
      model: 'gemini-4-carbon-high',
      events: 16,
      inputTokens: 284_000,
      cachedInputTokens: 238_000,
      outputTokens: 9_400,
      reasoningOutputTokens: 1_800,
      totalTokens: 293_400
    },
    {
      sessionId: '74d9c9ef-0638-4921-9092-be8f16764944',
      lastActiveAt: '2026-11-25T19:14:00.000Z',
      durationMinutes: 9,
      projectLabel: 'orca-docs',
      model: 'gemini-4-hydrogen-tiered-high',
      events: 8,
      inputTokens: 118_000,
      cachedInputTokens: 92_000,
      outputTokens: 4_100,
      reasoningOutputTokens: 700,
      totalTokens: 122_100
    }
  ]
}

function stubUsageApis(antigravitySnapshot: AntigravityUsageSnapshot): void {
  const disabledProvider = (presenceKey: string) => ({
    getScanState: () =>
      Promise.resolve({
        enabled: false,
        isScanning: false,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null,
        [presenceKey]: false
      }),
    setEnabled: () => Promise.reject(new Error('Not stubbed')),
    refresh: () => Promise.reject(new Error('Not stubbed')),
    getSnapshot: () => Promise.reject(new Error('Not stubbed')),
    getSummary: () => Promise.reject(new Error('Not stubbed')),
    getDaily: () => Promise.reject(new Error('Not stubbed')),
    getBreakdown: () => Promise.reject(new Error('Not stubbed')),
    getRecentSessions: () => Promise.reject(new Error('Not stubbed'))
  })
  Object.assign(window.api, {
    stats: {
      getSummary: () =>
        Promise.resolve({
          totalAgentsSpawned: 42,
          totalAgentTimeMs: 14_400_000,
          totalPRsCreated: 7,
          firstEventAt: SAMPLE_UPDATED_AT - 86_400_000 * 14
        })
    },
    claudeUsage: disabledProvider('hasAnyClaudeData'),
    codexUsage: disabledProvider('hasAnyCodexData'),
    openCodeUsage: disabledProvider('hasAnyOpenCodeData'),
    museUsage: disabledProvider('hasAnyMuseData'),
    antigravityUsage: {
      getScanState: () => Promise.resolve(antigravitySnapshot.scanState),
      setEnabled: () => Promise.resolve(antigravitySnapshot.scanState),
      refresh: () => Promise.resolve(antigravitySnapshot.scanState),
      getSnapshot: () => Promise.resolve(antigravitySnapshot),
      getSummary: () => Promise.resolve(antigravitySnapshot.summary),
      getDaily: () => Promise.resolve(antigravitySnapshot.daily),
      getBreakdown: ({ kind }: { kind: 'model' | 'project' }) =>
        Promise.resolve(
          kind === 'model'
            ? antigravitySnapshot.modelBreakdown
            : antigravitySnapshot.projectBreakdown
        ),
      getRecentSessions: () => Promise.resolve(antigravitySnapshot.recentSessions)
    }
  })
}

export const populated = defineFixture({
  width: 900,
  setup: () => stubUsageApis(POPULATED_SNAPSHOT),
  store: {
    antigravityUsageScanState: POPULATED_SNAPSHOT.scanState,
    antigravityUsageSummary: POPULATED_SNAPSHOT.summary,
    antigravityUsageDaily: POPULATED_SNAPSHOT.daily,
    antigravityUsageModelBreakdown: POPULATED_SNAPSHOT.modelBreakdown,
    antigravityUsageProjectBreakdown: POPULATED_SNAPSHOT.projectBreakdown,
    antigravityUsageRecentSessions: POPULATED_SNAPSHOT.recentSessions
  },
  render: () => <AntigravityUsagePane />
})

export const disabled = defineFixture({
  width: 900,
  setup: () =>
    stubUsageApis({
      ...POPULATED_SNAPSHOT,
      scanState: {
        enabled: false,
        isScanning: false,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null,
        hasAnyAntigravityData: false
      }
    }),
  store: {
    antigravityUsageScanState: {
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyAntigravityData: false
    }
  },
  render: () => <AntigravityUsagePane />
})

export const overviewWithAntigravity = defineFixture({
  width: 900,
  setup: () => stubUsageApis(POPULATED_SNAPSHOT),
  store: {
    antigravityUsageScanState: POPULATED_SNAPSHOT.scanState,
    antigravityUsageSummary: POPULATED_SNAPSHOT.summary,
    antigravityUsageDaily: POPULATED_SNAPSHOT.daily
  },
  render: () => <StatsPane />
})

export const providerDropdownOpen = defineFixture({
  width: 900,
  setup: () => stubUsageApis(POPULATED_SNAPSHOT),
  store: {
    antigravityUsageScanState: POPULATED_SNAPSHOT.scanState,
    antigravityUsageSummary: POPULATED_SNAPSHOT.summary,
    antigravityUsageDaily: POPULATED_SNAPSHOT.daily
  },
  interact: async (frame) => {
    const trigger = frame.querySelector<HTMLElement>('[data-testid="usage-provider-select"]')
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  },
  render: () => <StatsPane />
})
