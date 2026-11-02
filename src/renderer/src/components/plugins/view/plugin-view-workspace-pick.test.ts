import { describe, expect, it } from 'vitest'
import { pickWorkspaceToShow } from './plugin-view-workspace-pick'

describe('the workspace a shot selects when none is showing', () => {
  it("picks this machine's most recently active worktree, never an archived or remote one", () => {
    const repos = {
      r1: [
        { id: 'old', lastActivityAt: 1 },
        { id: 'archived', lastActivityAt: 9, isArchived: true }
      ],
      r2: [
        { id: 'remote', lastActivityAt: 8, hostId: 'ssh:box' },
        { id: 'recent', lastActivityAt: 5, hostId: 'local' }
      ]
    }
    expect(pickWorkspaceToShow(repos, [])).toBe('recent')
  })

  it('falls back to a local folder workspace, and to none', () => {
    const folders = [
      { id: 'remote', connectionId: 'box', isArchived: false },
      { id: 'notes', connectionId: null, isArchived: false }
    ]
    expect(pickWorkspaceToShow({}, folders)).toBe('folder:notes')
    expect(pickWorkspaceToShow(undefined, undefined)).toBeNull()
  })
})
