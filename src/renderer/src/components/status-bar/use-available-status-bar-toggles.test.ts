import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'

const store = vi.hoisted(() => ({
  state: {
    detectedAgentIds: [] as TuiAgent[],
    rateLimits: { antigravity: null as ProviderRateLimits | null }
  }
}))

vi.mock('../../store', () => ({
  useAppStore: <T>(selector: (state: typeof store.state) => T): T => selector(store.state)
}))

import { useAvailableStatusBarToggles } from './use-available-status-bar-toggles'

const toggles: { id: StatusBarItem }[] = [{ id: 'antigravity' }, { id: 'claude' }, { id: 'ssh' }]

function antigravitySnapshot(status: ProviderRateLimits['status']): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: 1,
    error: null,
    status
  }
}

describe('useAvailableStatusBarToggles', () => {
  it('keeps the Antigravity toggle for a desktop-only runtime snapshot', () => {
    store.state.detectedAgentIds = []
    store.state.rateLimits.antigravity = antigravitySnapshot('ok')

    expect(useAvailableStatusBarToggles(toggles).map((toggle) => toggle.id)).toEqual([
      'antigravity',
      'ssh'
    ])
  })

  it('hides the Antigravity toggle when neither runtime is available', () => {
    store.state.detectedAgentIds = []
    store.state.rateLimits.antigravity = {
      ...antigravitySnapshot('unavailable'),
      usageMetadata: { failureKind: 'cli-unavailable' }
    }

    expect(useAvailableStatusBarToggles(toggles).map((toggle) => toggle.id)).toEqual(['ssh'])
  })
})
