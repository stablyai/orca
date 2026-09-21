import { describe, expect, it } from 'vitest'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { resolveClaudeRowUsage } from './claude-account-usage'

function limits(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'ok'
  }
}

/** What a failed credential read actually looks like coming out of the fetcher. */
function failedLimits(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: 'No credentials',
    status: 'error'
  }
}

function entry(overrides: Partial<InactiveAccountUsage>): InactiveAccountUsage {
  return { accountId: 'b', rateLimits: null, updatedAt: 0, isFetching: false, ...overrides }
}

const base = {
  accountId: 'b',
  isActive: false,
  visible: true,
  targetMatchesRuntime: true,
  activeLimits: null,
  inactiveAccounts: [] as InactiveAccountUsage[],
  inactiveFetchSettled: false
}

describe('resolveClaudeRowUsage', () => {
  it('hides usage for remote-owned accounts', () => {
    expect(resolveClaudeRowUsage({ ...base, visible: false })).toEqual({ kind: 'hidden' })
  })

  // Why: the status bar can retarget the Claude poll to another runtime without
  // changing this pane's view, and a host percentage on a WSL row is a lie.
  it('hides the active row when the poll describes a different runtime', () => {
    expect(
      resolveClaudeRowUsage({
        ...base,
        isActive: true,
        targetMatchesRuntime: false,
        activeLimits: limits(12)
      })
    ).toEqual({ kind: 'hidden' })
  })

  it('reads the live poll for the active account', () => {
    expect(resolveClaudeRowUsage({ ...base, isActive: true, activeLimits: limits(12) })).toEqual({
      kind: 'ready',
      limits: limits(12),
      isFetching: false
    })
  })

  it('pulses the active row while its poll is refreshing', () => {
    const refreshing = { ...limits(12), status: 'fetching' as const }
    expect(resolveClaudeRowUsage({ ...base, isActive: true, activeLimits: refreshing })).toEqual({
      kind: 'ready',
      limits: refreshing,
      isFetching: true
    })
  })

  it('treats a missing active snapshot as loading, not unavailable', () => {
    expect(resolveClaudeRowUsage({ ...base, isActive: true })).toEqual({ kind: 'loading' })
  })

  // Why: the regression this guards. A failed read returns a snapshot with every
  // window null, so without the check it renders as usable data.
  it('reports unavailable when the active poll failed', () => {
    expect(
      resolveClaudeRowUsage({ ...base, isActive: true, activeLimits: failedLimits() })
    ).toEqual({ kind: 'unavailable' })
  })

  it('reports unavailable when an inactive account failed to authenticate', () => {
    expect(
      resolveClaudeRowUsage({ ...base, inactiveAccounts: [entry({ rateLimits: failedLimits() })] })
    ).toEqual({ kind: 'unavailable' })
  })

  it('shows a missing inactive entry as loading until the fetch settles', () => {
    expect(resolveClaudeRowUsage(base)).toEqual({ kind: 'loading' })
  })

  // Why: nothing re-runs the inactive fetch on its own, so a still-missing entry
  // after ours settled would otherwise skeleton for the life of the pane.
  it('stops loading a missing inactive entry once the fetch settled', () => {
    expect(resolveClaudeRowUsage({ ...base, inactiveFetchSettled: true })).toEqual({
      kind: 'unavailable'
    })
  })

  it('reports unavailable for a settled inactive entry carrying no snapshot', () => {
    expect(resolveClaudeRowUsage({ ...base, inactiveAccounts: [entry({})] })).toEqual({
      kind: 'unavailable'
    })
  })

  it('keeps loading while an inactive account is still fetching', () => {
    expect(
      resolveClaudeRowUsage({ ...base, inactiveAccounts: [entry({ isFetching: true })] })
    ).toEqual({ kind: 'loading' })
  })

  it('shows cached bars for an inactive account that is refreshing', () => {
    expect(
      resolveClaudeRowUsage({
        ...base,
        inactiveAccounts: [entry({ rateLimits: limits(44), isFetching: true })]
      })
    ).toEqual({ kind: 'ready', limits: limits(44), isFetching: true })
  })

  it('ignores entries belonging to a different account', () => {
    expect(
      resolveClaudeRowUsage({
        ...base,
        inactiveAccounts: [entry({ accountId: 'other', rateLimits: limits(90) })]
      })
    ).toEqual({ kind: 'loading' })
  })
})
