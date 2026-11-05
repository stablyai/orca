import { describe, expect, it } from 'vitest'
import type { AppState } from '../../../types'
import { resolveWorktreeCreateParent } from './worktree-create-parent-pick'

const PARENT = {
  id: 'srv-repo::/parent',
  hostId: 'runtime:srv',
  repoId: 'srv-repo',
  path: '/parent',
  displayName: 'parent',
  isArchived: false,
  instanceId: 'instance-parent'
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only repos, rows and the active scope.
const state = {
  repos: [{ id: 'srv-repo', executionHostId: 'runtime:srv' }],
  worktreesByRepo: { 'srv-repo': [PARENT] },
  activeWorkspaceKey: null
} as unknown as AppState

describe('a composer parent picked on another machine', () => {
  it('becomes an ordinary parent once the destination moves to that machine', () => {
    expect(
      resolveWorktreeCreateParent(state, 'runtime:srv|srv-repo::/parent', 'runtime:srv')
    ).toEqual({
      parentWorkspace: 'worktree:srv-repo::/parent',
      pickedParentWorktreeId: 'srv-repo::/parent',
      pickedDisplayName: 'parent',
      staleBeforeCreate: false
    })
  })
})
