import { describe, expect, it, vi } from 'vitest'
import { createHostedReviewFailureDiagnostics } from './hosted-review-failure-diagnostics'

describe('hosted review failure diagnostics', () => {
  it('deduplicates across HMR owners and resets after success', () => {
    const hotData: Record<string, unknown> = {}
    const warn = vi.fn()
    const firstOwner = createHostedReviewFailureDiagnostics(hotData, warn)
    const reloadedOwner = createHostedReviewFailureDiagnostics(hotData, warn)
    const failure = {
      kind: 'upstream-error' as const,
      provider: 'github' as const,
      errorType: 'network' as const
    }

    firstOwner.report('cache-key', 'repo-1', failure)
    reloadedOwner.report('cache-key', 'repo-1', failure)
    expect(warn).toHaveBeenCalledTimes(1)

    reloadedOwner.report('cache-key', 'repo-1', { ...failure, errorType: 'rate_limited' })
    expect(warn).toHaveBeenCalledTimes(2)

    firstOwner.clear('cache-key')
    reloadedOwner.report('cache-key', 'repo-1', failure)
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
