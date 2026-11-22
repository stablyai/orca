import { expect, it } from 'vitest'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import { resolveOwnerUsageRateLimits } from './owner-usage-rate-limits'
import { workspaceAccountUsage } from './workspace-account-usage'

it('marks absent and unavailable account-owned slots unverifiable when their host is unreachable', () => {
  const state = createEmptyRateLimitState()
  state.claude = {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'unavailable'
  }
  const unresolved = resolveOwnerUsageRateLimits(createEmptyRateLimitState(), {
    kind: 'remote-unverifiable',
    ownerLabel: 'Remote',
    reason: 'unreachable',
    lastKnown: state
  })
  expect(unresolved.codex).toBeNull()
  expect(unresolved.claude).toMatchObject({
    status: 'unavailable',
    session: null,
    weekly: null,
    usageMetadata: { unverifiableOwner: true }
  })
})

it('marks account-owned slots with quota unverifiable when their host is unreachable', () => {
  const state = createEmptyRateLimitState({
    claude: {
      provider: 'claude',
      session: { usedPercent: 40, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: 1,
      error: null,
      status: 'ok'
    }
  })
  const unresolved = resolveOwnerUsageRateLimits(createEmptyRateLimitState(), {
    kind: 'remote-unverifiable',
    ownerLabel: 'Remote',
    reason: 'unreachable',
    lastKnown: state
  })
  expect(unresolved.claude?.session).toBeNull()
  expect(unresolved.claude?.usageMetadata?.unverifiableOwner).toBe(true)
})

it('drops inactive account readings when an unreachable owner has no primary slot', () => {
  const lastKnown = createEmptyRateLimitState({
    inactiveClaudeAccounts: [
      {
        accountId: 'work',
        rateLimits: {
          provider: 'claude',
          session: {
            usedPercent: 37,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
          weekly: null,
          updatedAt: 1,
          error: null,
          status: 'ok'
        },
        updatedAt: 1,
        isFetching: false
      }
    ]
  })
  const unresolved = resolveOwnerUsageRateLimits(createEmptyRateLimitState(), {
    kind: 'remote-unverifiable',
    ownerLabel: 'Remote',
    reason: 'unreachable',
    lastKnown
  })

  expect(unresolved.inactiveClaudeAccounts).toEqual([])
  expect(workspaceAccountUsage(unresolved, 'claude', 'work')).toMatchObject({
    session: null,
    status: 'unavailable'
  })
})
