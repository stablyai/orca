// @vitest-environment happy-dom
import { cleanup, renderHook, act } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state, openTarget: vi.fn(), openPage: vi.fn(), clock: vi.fn(() => 1_000_000_000) }
})
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))
vi.mock('@/store/selectors', () => ({ selectFloatingWorkspaceHasUnread: () => false }))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => '' }))
vi.mock('@/hooks/useResetCountdownClock', () => ({ useResetCountdownClock: mocks.clock }))
vi.mock('./ProviderDetailsMenu', () => ({
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'close-menus',
  useStatusBarMenuFocusHandoff: () => ({ reset: vi.fn() })
}))
vi.mock('./status-bar-density', () => ({
  useStatusBarDensity: () => ({
    density: {
      compact: false,
      usageTightestOnly: false,
      segmentsIconOnly: false,
      collapseUsage: false
    },
    overflowing: false,
    collapsedUsageProviders: [],
    barRef: { current: null },
    usageRef: { current: null },
    segmentsRef: { current: null }
  })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, text: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
      text
    )
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => <span /> }))

import { useStatusBarController } from './use-status-bar-controller'
import { ProviderSegment } from './StatusBarProviderSegment'
import { ProviderPanel } from './tooltip'
import { UsageRow } from './UsageRosterPanel'

const now = 1_000_000_000
const synthetic: ProviderRateLimits = {
  provider: 'synthetic',
  status: 'ok',
  error: null,
  updatedAt: now,
  session: {
    usedPercent: 20,
    windowMinutes: 300,
    resetsAt: null,
    resetDescription: null,
    refillsAt: now + 15 * 60_000
  },
  weekly: {
    usedPercent: 40,
    windowMinutes: 10080,
    resetsAt: null,
    resetDescription: null,
    refillsAt: now + 3 * 60 * 60_000
  },
  requestQuota: { requests: 100, limit: 500, renewsAt: null }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state = {
    rateLimits: { ...createEmptyRateLimitState(), synthetic },
    settings: getDefaultSettings('/home/test'),
    statusBarVisible: true,
    statusBarItems: ['synthetic'],
    statusBarUsageMode: 'verbose',
    usagePercentageDisplay: 'used',
    usageEmptyStateDismissed: false,
    detectedAgentIds: [],
    ensureDetectedAgents: vi.fn(),
    refreshDetectedAgents: vi.fn(),
    refreshRateLimits: vi.fn(),
    openSettingsTarget: mocks.openTarget,
    openSettingsPage: mocks.openPage,
    toggleStatusBarItem: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    setStatusBarUsageMode: vi.fn()
  }
})
afterEach(cleanup)

describe('Synthetic status bar', () => {
  it('does not label subscription-only usage as a five-hour quota', () => {
    const legacy: ProviderRateLimits = {
      ...synthetic,
      session: {
        usedPercent: 20,
        windowMinutes: 300,
        resetsAt: now + 900_000,
        refillsAt: null,
        resetDescription: null
      },
      weekly: null
    }
    const markup = renderToStaticMarkup(<ProviderPanel p={legacy} />)
    expect(markup).toContain('Request usage')
    expect(markup).toContain('Resets in 15m')
    expect(markup).not.toContain('Five-hour')
  })
  it('shows a configured snapshot without requiring a Synthetic CLI', () => {
    const { result } = renderHook(() => useStatusBarController(false))
    expect(result.current?.rosterProviders).toEqual([synthetic])
    expect(result.current?.hasVisibleUsageMeters).toBe(true)
    expect(result.current?.isEmptyUsageState).toBe(false)
    act(() => result.current?.handleOpenProviderAccounts('synthetic'))
    expect(mocks.openTarget).toHaveBeenCalledWith({
      pane: 'accounts',
      repoId: null,
      sectionId: 'accounts-synthetic'
    })
  })

  it('respects the visibility toggle', () => {
    mocks.state.statusBarItems = []
    const { result } = renderHook(() => useStatusBarController(false))
    expect(result.current?.rosterProviders).toEqual([])
    expect(result.current?.hasVisibleUsageMeters).toBe(false)
  })

  it('keeps a configured meter while the first snapshot is pending', () => {
    mocks.state.settings = { ...getDefaultSettings('/home/test'), syntheticApiKey: 'placeholder' }
    mocks.state.rateLimits = createEmptyRateLimitState()
    const { result } = renderHook(() => useStatusBarController(false))
    expect(result.current?.rosterProviders[0]).toMatchObject({
      provider: 'synthetic',
      status: 'fetching'
    })
  })

  it('renders percentages in detailed and compact segments', () => {
    const detailed = renderToStaticMarkup(
      <ProviderSegment p={synthetic} compact={false} display="used" />
    )
    const compact = renderToStaticMarkup(
      <ProviderSegment p={synthetic} compact={false} display="used" mode="compact" />
    )
    expect(detailed).toContain('20%')
    expect(detailed).toContain('40%')
    expect(compact).toContain('40%')
  })

  it('shows request counts with the five-hour window and partial-refill countdowns', () => {
    const markup = renderToStaticMarkup(<ProviderPanel p={synthetic} />)
    expect(markup).toContain('Synthetic')
    expect(markup).toContain('100 / 500 requests used')
    expect(markup.indexOf('100 / 500 requests used')).toBeLessThan(
      markup.indexOf('Weekly credit usage')
    )
    expect(markup).toContain('Next refill in 15m')
    expect(markup).toContain('Next refill in 3h')
    expect(markup).not.toContain('Resets')
    expect(mocks.clock).toHaveBeenCalledWith([
      synthetic.session?.refillsAt,
      synthetic.weekly?.refillsAt
    ])
  })

  it('shows the soonest refill and weighted request counts in the roster', () => {
    const markup = renderToStaticMarkup(
      <UsageRow
        p={synthetic}
        display="used"
        state={{ kind: 'usage', statusLabel: null }}
        showSignInAction={false}
        now={now}
      />
    )
    expect(markup).toContain('Next refill in 15m')
    expect(markup).toContain('100 / 500 requests used')
  })

  it('summarizes when both allowances are fully recharged', () => {
    const fullRecharge: ProviderRateLimits = {
      ...synthetic,
      session: synthetic.session ? { ...synthetic.session, rechargesAt: now + 3_600_000 } : null,
      weekly: synthetic.weekly
        ? { ...synthetic.weekly, rechargesAt: now + 2 * 24 * 3_600_000 }
        : null
    }
    const row = renderToStaticMarkup(
      <UsageRow
        p={fullRecharge}
        display="used"
        state={{ kind: 'usage', statusLabel: null }}
        showSignInAction={false}
        now={now}
      />
    )
    expect(row).toContain('Full recharge in 2d')
    const panel = renderToStaticMarkup(<ProviderPanel p={fullRecharge} />)
    expect(panel).toContain('Full recharge in 1h')
    expect(panel).toContain('Full recharge in 2d')
    expect(panel).toContain('Next refill in 15m')
    expect(panel).toContain('Estimated if no more usage.')
  })

  it('shows no refill countdown when the quota has fully replenished', () => {
    const full: ProviderRateLimits = {
      ...synthetic,
      session: {
        usedPercent: 0,
        windowMinutes: 300,
        resetsAt: null,
        refillsAt: null,
        resetDescription: null
      },
      weekly: {
        usedPercent: 0,
        windowMinutes: 10080,
        resetsAt: null,
        refillsAt: null,
        resetDescription: null
      }
    }
    expect(renderToStaticMarkup(<ProviderPanel p={full} />)).not.toContain('Next refill')
  })
})
