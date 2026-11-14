import { describe, expect, it } from 'vitest'
import type { AppState } from '../../../types'
import { createTestStore } from '../worktrees-slice-test-harness'
import { makeWorktree } from '../worktree.test-fixture'
import { TEST_REPO } from '../../../repos/repo.test-fixture'
import { resolveWorktreeCreateParent } from './worktree-create-parent-pick'
import { makeFolderWorkspace } from '../../../folder-workspaces/folder-workspace.test-fixture'
import {
  buildLocalWorktreeCreateArgs,
  buildRuntimeWorktreeCreateParams
} from './worktree-create-payload'

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

it('drops a retained parent pick after durable removal, but keeps legacy pending picks', () => {
  const store = createTestStore()
  const parent = makeWorktree({
    id: 'repo1::/parent',
    repoId: 'repo1',
    hostId: 'local',
    displayName: 'Parent',
    removing: true
  })
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [parent] },
    folderWorkspaces: [makeFolderWorkspace()],
    activeWorkspaceKey: 'folder:folder-1'
  })
  expect(resolveWorktreeCreateParent(store.getState(), parent.id, 'local').staleBeforeCreate).toBe(
    false
  )
  expect(resolveWorktreeCreateParent(store.getState(), undefined, 'local').parentWorkspace).toBe(
    'folder:folder-1'
  )
  store.setState({ worktreesByRepo: { repo1: [{ ...parent, removalRecorded: true }] } })
  for (const pick of [parent.id, `local|${parent.id}`]) {
    const selection = resolveWorktreeCreateParent(store.getState(), pick, 'local')
    expect(selection).toEqual({
      pickedDisplayName: 'Parent',
      staleBeforeCreate: true
    })
    const request = {
      repoId: TEST_REPO.id,
      name: 'child',
      baseBranch: 'main',
      setupDecision: 'skip' as const
    }
    const attempt = { name: 'child', parentWorkspace: selection.parentWorkspace }
    for (const payload of [
      buildLocalWorktreeCreateArgs(request, attempt),
      buildRuntimeWorktreeCreateParams(request, attempt)
    ]) {
      expect(payload).not.toHaveProperty('parentWorkspace')
      expect(payload).not.toHaveProperty('crossStoreParent')
      expect(payload).not.toHaveProperty('parentWorkspaceOrigin')
    }
    expect(
      resolveWorktreeCreateParent(store.getState(), pick, 'runtime:other').crossStoreParentRow
    ).toBeUndefined()
  }
})
