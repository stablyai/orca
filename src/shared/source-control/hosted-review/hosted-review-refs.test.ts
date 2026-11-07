import { describe, expect, it } from 'vitest'
import { isRemoteHeadRef } from './hosted-review-refs'

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
