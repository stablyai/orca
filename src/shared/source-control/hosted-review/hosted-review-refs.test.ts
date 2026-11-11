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
})
