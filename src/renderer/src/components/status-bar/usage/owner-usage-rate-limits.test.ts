import { expect, it } from 'vitest'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import { resolveOwnerUsageRateLimits } from './owner-usage-rate-limits'

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
  expect(unresolved.codex?.usageMetadata?.unverifiableOwner).toBe(true)
  expect(unresolved.claude?.usageMetadata?.unverifiableOwner).toBe(true)
})
