import { describe, expect, it } from 'vitest'
import {
  isRemoteHeadRef,
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from './hosted-review-refs'

describe('hosted review ref normalization', () => {
  it('normalizes local and remote head refs to branch names', () => {
    expect(normalizeHostedReviewHeadRef(' refs/heads/feature/create-pr ')).toBe('feature/create-pr')
    expect(normalizeHostedReviewHeadRef('refs/remotes/origin/feature/create-pr')).toBe(
      'feature/create-pr'
    )
  })

  it('strips common remote prefixes from base refs', () => {
    expect(normalizeHostedReviewBaseRef('origin/main')).toBe('main')
    expect(normalizeHostedReviewBaseRef('refs/remotes/upstream/release/1.0')).toBe('release/1.0')
  })
})

describe('isRemoteHeadRef', () => {
  it('recognizes only a remote symbolic HEAD slot', () => {
    expect(isRemoteHeadRef('origin/HEAD', ['origin'])).toBe(true)
    expect(isRemoteHeadRef('refs/remotes/origin/HEAD', ['origin'])).toBe(true)
    expect(isRemoteHeadRef('origin/feature/HEAD', ['origin'])).toBe(false)
    expect(isRemoteHeadRef('refs/remotes/origin/feature/HEAD', ['origin'])).toBe(false)
    expect(isRemoteHeadRef('refs/heads/feature/HEAD', ['origin'])).toBe(false)
  })

  it('uses the longest configured remote prefix', () => {
    const remotes = ['foo', 'foo/bar']
    expect(isRemoteHeadRef('foo/bar/HEAD', remotes)).toBe(true)
    expect(isRemoteHeadRef('foo/bar/feature/HEAD', remotes)).toBe(false)
  })

  it('recognizes the conventional unconfigured remote shape', () => {
    expect(isRemoteHeadRef('orphan/HEAD')).toBe(true)
    expect(isRemoteHeadRef('orphan/feature/HEAD')).toBe(false)
  })
})
