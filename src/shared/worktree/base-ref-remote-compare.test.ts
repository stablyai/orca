import { describe, expect, it, vi } from 'vitest'
import { preferRemoteTrackingCompareBase, resolveBranchCompareBaseRef } from './base-ref'

describe('preferRemoteTrackingCompareBase', () => {
  it('prefers origin/master over a stale local master pin', () => {
    expect(preferRemoteTrackingCompareBase('master', 'origin/master')).toBe('origin/master')
    expect(preferRemoteTrackingCompareBase('refs/heads/master', 'origin/master')).toBe(
      'origin/master'
    )
    expect(preferRemoteTrackingCompareBase('refs/heads/master', 'refs/remotes/origin/master')).toBe(
      'refs/remotes/origin/master'
    )
  })

  it('keeps a remote-qualified worktree pin even when the repo default differs', () => {
    expect(preferRemoteTrackingCompareBase('origin/release', 'origin/master')).toBe(
      'origin/release'
    )
  })

  it('keeps a local pin when the candidate is a different branch', () => {
    expect(preferRemoteTrackingCompareBase('master', 'origin/develop')).toBe('master')
  })

  it('falls through to the remote candidate when the worktree pin is empty', () => {
    expect(preferRemoteTrackingCompareBase('  ', 'origin/master')).toBe('origin/master')
    expect(preferRemoteTrackingCompareBase(null, null)).toBeNull()
  })
})

describe('resolveBranchCompareBaseRef', () => {
  it('prefers origin/master when the compare base is a local master ref', async () => {
    const existing = new Set(['refs/remotes/origin/master', 'refs/heads/master'])
    const refExists = vi.fn(async (ref: string) => existing.has(ref))

    await expect(resolveBranchCompareBaseRef('master', refExists)).resolves.toBe(
      'refs/remotes/origin/master'
    )
    await expect(resolveBranchCompareBaseRef('refs/heads/master', refExists)).resolves.toBe(
      'refs/remotes/origin/master'
    )
    expect(refExists).toHaveBeenCalledWith('refs/remotes/origin/master')
  })

  it('falls back to the local branch when origin/<branch> is missing', async () => {
    const refExists = vi.fn(async (ref: string) => ref === 'refs/heads/master')

    await expect(resolveBranchCompareBaseRef('master', refExists)).resolves.toBe(
      'refs/heads/master'
    )
    expect(refExists.mock.calls.map((call) => call[0])).toEqual([
      'refs/remotes/origin/master',
      'refs/heads/master'
    ])
  })

  it('leaves an already remote-qualified compare base on the remote-tracking path', async () => {
    const refExists = vi.fn(async (ref: string) => ref === 'refs/remotes/origin/master')

    await expect(resolveBranchCompareBaseRef('origin/master', refExists)).resolves.toBe(
      'refs/remotes/origin/master'
    )
    expect(refExists).toHaveBeenCalledWith('refs/remotes/origin/master')
    expect(refExists).not.toHaveBeenCalledWith('refs/heads/master')
  })
})
