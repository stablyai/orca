import { describe, expect, it } from 'vitest'
import { getManagedBrowserProfileOwner } from './browser-profile-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'

describe('getManagedBrowserProfileOwner', () => {
  it('names the owner whose removal deletes the profile', () => {
    expect(getManagedBrowserProfileOwner('repo', 'repo-1::/work/a')).toEqual({
      kind: 'repo',
      id: 'repo-1'
    })
    expect(getManagedBrowserProfileOwner('worktree', 'repo-1::/work/a')).toEqual({
      kind: 'worktree',
      id: 'repo-1::/work/a'
    })
    // A standalone folder workspace is in no repo; its own deletion must find the profile.
    expect(getManagedBrowserProfileOwner('repo', 'folder:f-1')).toEqual({
      kind: 'worktree',
      id: 'folder:f-1'
    })
    expect(getManagedBrowserProfileOwner('repo', FLOATING_TERMINAL_WORKTREE_ID)).toBeNull()
    expect(getManagedBrowserProfileOwner('shared', 'repo-1::/work/a')).toBeNull()
    expect(getManagedBrowserProfileOwner(undefined, 'repo-1::/work/a')).toBeNull()
  })
})
