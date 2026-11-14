import { describe, expect, it } from 'vitest'
import { isRemoteHeadRef, normalizeCreateReviewBaseSearchResults } from './hosted-review-refs'
import { legacyBaseRefSearchResult } from '../../base-ref-search-result'

it('normalizes old-server refs-only replies before treating provider details as authoritative', () => {
  expect(
    normalizeCreateReviewBaseSearchResults(
      ['refs/heads/feature/topic', 'refs/remotes/origin/main', 'origin/topic'].map(
        legacyBaseRefSearchResult
      )
    )
  ).toEqual(['feature/topic', 'main', 'topic'])
})

it('keeps authoritative provider branch names from canonical search details', () => {
  expect(
    normalizeCreateReviewBaseSearchResults([
      { refName: 'refs/heads/origin/topic', localBranchName: 'origin/topic' },
      { refName: 'refs/remotes/team/fork/release/topic', localBranchName: 'release/topic' }
    ])
  ).toEqual(['origin/topic', 'release/topic'])
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
