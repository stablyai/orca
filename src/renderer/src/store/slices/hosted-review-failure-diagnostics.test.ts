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

  it('keeps request ownership monotonic across HMR owners', () => {
    const hotData: Record<string, unknown> = {}
    const firstOwner = createHostedReviewFailureDiagnostics(hotData)
    const reloadedOwner = createHostedReviewFailureDiagnostics(hotData)

    const olderGeneration = firstOwner.claimRequest('cache-key')
    const currentGeneration = reloadedOwner.claimRequest('cache-key')

    expect(firstOwner.ownsRequest('cache-key', olderGeneration)).toBe(false)
    expect(reloadedOwner.ownsRequest('cache-key', currentGeneration)).toBe(true)

    firstOwner.finishRequest('cache-key', olderGeneration)
    expect(reloadedOwner.ownsRequest('cache-key', currentGeneration)).toBe(true)

    reloadedOwner.finishRequest('cache-key', currentGeneration)
    expect(reloadedOwner.requestGenerationCount()).toBe(0)
  })

  it('preserves signatures when upgrading legacy HMR registry data', () => {
    const signatures = new Map([['cache-key', 'github:network']])
    const hotData: Record<string, unknown> = {
      hostedReviewFailureDiagnosticSignatures: signatures
    }
    const warn = vi.fn()
    const diagnostics = createHostedReviewFailureDiagnostics(hotData, warn)
    const generation = diagnostics.claimRequest('cache-key')

    diagnostics.report('cache-key', 'repo-1', {
      kind: 'upstream-error',
      provider: 'github',
      errorType: 'network'
    })

    expect(warn).not.toHaveBeenCalled()
    expect(diagnostics.ownsRequest('cache-key', generation)).toBe(true)
    expect(hotData.hostedReviewFailureDiagnosticSignatures).toMatchObject({ signatures })
  })
})
