import { describe, expect, it } from 'vitest'
import { resolvePRBranchFallback, shouldAcceptMergedFallbackPR } from './pr-branch-fallback-rule'

describe('resolvePRBranchFallback', () => {
  it('drops a merged last PR once the head moved past it, without asking the hint', () => {
    const fallback = resolvePRBranchFallback({
      linkedPRNumber: null,
      cachedPR: {
        number: 41,
        state: 'merged',
        headSha: 'merged-head',
        confirmedContainedHeadOid: 'older-head'
      },
      hintPRNumber: 7,
      currentHeadOid: 'new-head'
    })
    expect(fallback).toEqual({ fallbackPRNumber: null, fallbackPRSource: null })
    expect(shouldAcceptMergedFallbackPR({ linkedPRNumber: null, ...fallback })).toBe(false)
  })

  it('falls back to a cached open PR with merged fallbacks accepted', () => {
    const fallback = resolvePRBranchFallback({
      linkedPRNumber: null,
      cachedPR: { number: 41, state: 'open', headSha: 'old-head' },
      hintPRNumber: 7,
      currentHeadOid: 'new-head'
    })
    expect(fallback).toEqual({ fallbackPRNumber: 41, fallbackPRSource: 'pr-cache' })
    expect(shouldAcceptMergedFallbackPR({ linkedPRNumber: null, ...fallback })).toBe(true)
  })
})
