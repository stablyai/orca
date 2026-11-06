import { describe, expect, it } from 'vitest'
import type { AppState } from '../../../types'
import { createTestStore } from '../../worktrees-slice-test-harness'
import { makeWorktree, TEST_REPO } from '../../worktrees-slice-test-fixtures'
import { resolveWorktreeCreateParent } from './worktree-create-parent-pick'

describe('worktree creation parent resolution', () => {
  it('drops a hostless local parent when a same-ID repository is targeted remotely', () => {
    const store = createTestStore()
    store.setState({
      repos: [{ ...TEST_REPO, executionHostId: 'runtime:server-a' }, TEST_REPO],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'repo1::/parent', repoId: 'repo1' })]
      }
    })

    expect(
      resolveWorktreeCreateParent(store.getState(), 'repo1::/parent', 'runtime:server-a')
    ).toEqual({
      parentWorkspace: undefined,
      pickedDisplayName: null,
      staleBeforeCreate: true
    })
  })

  it('retains a nested SSH parent when creating through its owning runtime', () => {
    const store = createTestStore()
    store.setState({
      repos: [
        { ...TEST_REPO, executionHostId: 'runtime:server-b', connectionId: 'builder' },
        { ...TEST_REPO, connectionId: 'builder' },
        { ...TEST_REPO, executionHostId: 'runtime:server-a', connectionId: 'builder' }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: 'repo1::/parent',
            repoId: 'repo1',
            hostId: 'ssh:builder',
            runtimeOwnerEnvironmentId: 'server-a',
            displayName: 'Parent'
          })
        ]
      },
      activeWorkspaceExecutionHostId: 'runtime:server-b'
    })

    expect(
      resolveWorktreeCreateParent(store.getState(), 'repo1::/parent', 'runtime:server-a')
    ).toEqual({
      parentWorkspace: 'worktree:repo1::/parent',
      pickedParentWorktreeId: 'repo1::/parent',
      pickedDisplayName: 'Parent',
      staleBeforeCreate: false
    })
    for (const hostId of ['runtime:server-b', 'ssh:builder'] as const) {
      expect(resolveWorktreeCreateParent(store.getState(), 'repo1::/parent', hostId)).toEqual({
        parentWorkspace: undefined,
        pickedDisplayName: null,
        staleBeforeCreate: true
      })
    }
  })
})

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
