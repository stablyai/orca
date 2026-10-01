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

/** Pre-change implementation, kept inline as the differential oracle for the fast path. */
function isRemoteHeadRefOracle(ref: string, remotes: readonly string[] = []): boolean {
  const shortRef = ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref
  const remote = [...remotes]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => shortRef.startsWith(`${candidate}/`))
  if (remote) {
    return shortRef.slice(remote.length + 1) === 'HEAD'
  }
  return shortRef.split('/').length === 2 && shortRef.endsWith('/HEAD')
}

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

const REF_PREFIXES = ['', 'refs/remotes/', 'refs/heads/', 'refs/remotes/origin/']
const REF_BODIES = [
  '',
  '/HEAD',
  'HEAD',
  'HEAD/HEAD',
  'main',
  'feature/HEAD',
  'a/b/c/HEAD',
  'origin',
  'origin/HEAD',
  'origin/main',
  'origin/head',
  'origin/HEADX',
  'origin/HEAD/x',
  'origin/feature/HEAD',
  'up/HEAD',
  'upstream/HEAD',
  'foo/HEAD',
  'foo/bar/HEAD',
  'foo/bar/baz/HEAD',
  'foo/bar/main',
  'foo/barbaz/HEAD'
]
const REMOTE_POOL = [
  'origin',
  'up',
  'upstream',
  'foo',
  'foo/bar',
  'foo/bar/baz',
  'foo/barbaz',
  'HEAD'
]

const ALL_REFS = REF_PREFIXES.flatMap((prefix) => REF_BODIES.map((body) => `${prefix}${body}`))
const ALL_REMOTE_SETS = Array.from({ length: 1 << REMOTE_POOL.length }, (_unused, mask) =>
  REMOTE_POOL.filter((_remote, bit) => (mask & (1 << bit)) !== 0)
)

describe('isRemoteHeadRef fast path', () => {
  it('matches the pre-change implementation across every ref x remote-set combination', () => {
    let combinations = 0
    const mismatches: string[] = []
    for (const ref of ALL_REFS) {
      for (const remoteSet of ALL_REMOTE_SETS) {
        // Duplicated + reversed variant exercises the sort's tie handling too.
        for (const remotes of [remoteSet, [...remoteSet, ...remoteSet].toReversed()]) {
          combinations += 1
          if (isRemoteHeadRef(ref, remotes) !== isRemoteHeadRefOracle(ref, remotes)) {
            mismatches.push(`${ref} | [${remotes.join(',')}]`)
          }
        }
      }
    }
    expect(mismatches).toEqual([])
    expect(combinations).toBe(ALL_REFS.length * ALL_REMOTE_SETS.length * 2)
    expect(combinations).toBe(43008)
  })

  it('also matches the oracle when remotes are omitted entirely', () => {
    for (const ref of ALL_REFS) {
      expect(isRemoteHeadRef(ref)).toBe(isRemoteHeadRefOracle(ref))
    }
  })

  it('copies and sorts nothing for ordinary refs that the oracle copies once each', () => {
    const ordinaryRefs = Array.from(
      { length: 80 },
      (_unused, index) => `origin/feature/branch-${index}`
    )
    const remoteNames = ['origin', 'upstream', 'fork']

    const before = instrumentRemotes(remoteNames)
    for (const ref of ordinaryRefs) {
      expect(isRemoteHeadRefOracle(ref, before.remotes)).toBe(false)
    }
    expect(before.counts).toEqual({ copies: 80, copiedElements: 240 })

    const after = instrumentRemotes(remoteNames)
    for (const ref of ordinaryRefs) {
      expect(isRemoteHeadRef(ref, after.remotes)).toBe(false)
    }
    expect(after.counts).toEqual({ copies: 0, copiedElements: 0 })
  })

  it('scales the skipped copies linearly with candidate count', () => {
    const remoteNames = ['origin', 'upstream', 'fork']
    const candidates = Array.from({ length: 4104 }, (_unused, index) =>
      index % 2 === 0 ? `refs/remotes/origin/branch-${index}` : `refs/heads/branch-${index}`
    )

    const before = instrumentRemotes(remoteNames)
    for (const ref of candidates) {
      isRemoteHeadRefOracle(ref, before.remotes)
    }
    expect(before.counts.copies).toBe(4104)

    const after = instrumentRemotes(remoteNames)
    for (const ref of candidates) {
      isRemoteHeadRef(ref, after.remotes)
    }
    expect(after.counts.copies).toBe(0)
  })

  it('still copies and sorts for a /HEAD candidate, which now pays one extra suffix check', () => {
    const remoteNames = ['origin', 'upstream', 'fork']

    const before = instrumentRemotes(remoteNames)
    expect(isRemoteHeadRefOracle('refs/remotes/origin/HEAD', before.remotes)).toBe(true)

    const after = instrumentRemotes(remoteNames)
    expect(isRemoteHeadRef('refs/remotes/origin/HEAD', after.remotes)).toBe(true)

    expect(after.counts).toEqual(before.counts)
    expect(after.counts).toEqual({ copies: 1, copiedElements: 3 })
  })
})
