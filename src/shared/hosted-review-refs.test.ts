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

  it('uses the longest match among overlapping slash-containing remotes', () => {
    const remotes = ['foo', 'foo/bar', 'foo/bar/baz', 'foo/barbaz']
    expect(isRemoteHeadRef('foo/bar/baz/HEAD', remotes)).toBe(true)
    expect(isRemoteHeadRef('foo/barbaz/HEAD', remotes)).toBe(true)
    expect(isRemoteHeadRef('foo/bar/baz/qux/HEAD', remotes)).toBe(false)
    expect(isRemoteHeadRef('refs/remotes/foo/bar/HEAD', remotes)).toBe(true)
  })

  it('rejects nested HEAD segments regardless of depth', () => {
    expect(isRemoteHeadRef('origin/HEAD/HEAD', ['origin'])).toBe(false)
    expect(isRemoteHeadRef('origin/a/b/c/HEAD', ['origin'])).toBe(false)
    expect(isRemoteHeadRef('refs/remotes/origin/HEAD/nested/HEAD', ['origin'])).toBe(false)
    expect(isRemoteHeadRef('HEAD', ['origin'])).toBe(false)
  })

  it('is unaffected by duplicate and reordered remote entries', () => {
    expect(isRemoteHeadRef('foo/bar/HEAD', ['foo/bar', 'foo', 'foo/bar', 'foo'])).toBe(true)
    expect(isRemoteHeadRef('foo/bar/feature/HEAD', ['foo', 'foo/bar', 'foo', 'foo/bar'])).toBe(
      false
    )
  })

  it('does not mutate or require a mutable remotes array', () => {
    const remotes = Object.freeze(['foo', 'foo/bar'])
    expect(isRemoteHeadRef('foo/bar/HEAD', remotes)).toBe(true)
    expect(isRemoteHeadRef('foo/bar/main', remotes)).toBe(false)
    expect(remotes).toEqual(['foo', 'foo/bar'])
  })
})

/** Counts array copies (`[...remotes]`, one per sort) and elements copied, via the spread iterator. */
function instrumentRemotes(names: readonly string[]): {
  remotes: readonly string[]
  counts: { copies: number; copiedElements: number }
} {
  const remotes = [...names]
  const counts = { copies: 0, copiedElements: 0 }
  Object.defineProperty(remotes, Symbol.iterator, {
    configurable: true,
    value: function* countingIterator(this: readonly string[]) {
      counts.copies += 1
      for (let index = 0; index < this.length; index += 1) {
        counts.copiedElements += 1
        yield this[index] as string
      }
    }
  })
  return { remotes, counts }
}

describe('isRemoteHeadRef fast path', () => {
  it('does not copy remotes while rejecting ordinary refs', () => {
    const ordinaryRefs = Array.from(
      { length: 80 },
      (_unused, index) => `origin/feature/branch-${index}`
    )
    const remoteNames = ['origin', 'upstream', 'fork']

    const after = instrumentRemotes(remoteNames)
    for (const ref of ordinaryRefs) {
      expect(isRemoteHeadRef(ref, after.remotes)).toBe(false)
    }
    expect(after.counts).toEqual({ copies: 0, copiedElements: 0 })
  })

  it('copies each remote once for a symbolic HEAD candidate', () => {
    const remoteNames = ['origin', 'upstream', 'fork']

    const after = instrumentRemotes(remoteNames)
    expect(isRemoteHeadRef('refs/remotes/origin/HEAD', after.remotes)).toBe(true)

    expect(after.counts).toEqual({ copies: 1, copiedElements: 3 })
  })
})
