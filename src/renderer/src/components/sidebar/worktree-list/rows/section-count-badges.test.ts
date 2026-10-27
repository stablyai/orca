import { describe, expect, it } from 'vitest'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getSectionCountBadges } from './section-workspace-count-badges'

const NO_ATTENTION: ReadonlySet<string> = new Set()

describe('getSectionCountBadges', () => {
  it('shows nothing while the badge is off', () => {
    expect(
      getSectionCountBadges(
        { count: 3, countedWorkspaceIds: ['a', 'b', 'c'] },
        'off',
        new Set(['a'])
      )
    ).toEqual({ total: null, attention: null })
  })

  it('shows only the waiting count in attention mode', () => {
    expect(
      getSectionCountBadges(
        { count: 3, countedWorkspaceIds: ['a', 'b', 'c'] },
        'attention',
        new Set(['a', 'c'])
      )
    ).toEqual({ total: null, attention: 2 })
  })

  it('drops the waiting badge when nothing waits', () => {
    expect(
      getSectionCountBadges(
        { count: 2, countedWorkspaceIds: ['a', 'b'] },
        'attention',
        NO_ATTENTION
      )
    ).toEqual({ total: null, attention: null })
  })

  it('shows the total alongside the waiting count in all mode', () => {
    expect(
      getSectionCountBadges(
        { count: 3, countedWorkspaceIds: ['a', 'b', 'c'] },
        'all',
        new Set(['b'])
      )
    ).toEqual({ total: 3, attention: 1 })
  })

  it('shows nothing for an empty group in any mode', () => {
    expect(
      getSectionCountBadges({ count: 0, countedWorkspaceIds: [] }, 'all', NO_ATTENTION)
    ).toEqual({ total: null, attention: null })
  })

  it('counts a project group s workspaces, not the child projects its count carries', () => {
    // A group of two projects holding five workspaces between them.
    expect(
      getSectionCountBadges(
        { count: 2, countedWorkspaceIds: ['a', 'b', 'c', 'd', 'e'] },
        'all',
        new Set(['d'])
      )
    ).toEqual({ total: 5, attention: 1 })
  })

  it('counts only the waiting twin when one repo is checked out on two hosts', () => {
    const local = composeWorktreeHostIdentity('local', 'repo::/wt')
    const remote = composeWorktreeHostIdentity('ssh:box', 'repo::/wt')
    expect(
      getSectionCountBadges({ count: 1, countedWorkspaceIds: [local] }, 'all', new Set([remote]))
    ).toEqual({ total: 1, attention: null })
    expect(
      getSectionCountBadges({ count: 1, countedWorkspaceIds: [remote] }, 'all', new Set([remote]))
    ).toEqual({ total: 1, attention: 1 })
  })

  it('ignores attention workspaces outside the group', () => {
    expect(
      getSectionCountBadges(
        { count: 2, countedWorkspaceIds: ['a', 'b'] },
        'all',
        new Set(['hidden-by-filter', 'archived'])
      )
    ).toEqual({ total: 2, attention: null })
  })

  it('counts a workspace listed under two lanes of one subtree once in both badges', () => {
    expect(
      getSectionCountBadges(
        { count: 3, countedWorkspaceIds: ['a', 'b', 'a'] },
        'all',
        new Set(['a'])
      )
    ).toEqual({ total: 2, attention: 1 })
  })

  it('falls back to count when a header carries no workspace ids', () => {
    expect(getSectionCountBadges({ count: 4 }, 'all', new Set(['a']))).toEqual({
      total: 4,
      attention: null
    })
  })
})
