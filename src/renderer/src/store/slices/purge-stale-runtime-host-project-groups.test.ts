/**
 * Project-group coverage for `purgeStaleRuntimeHostState`.
 *
 * When a paired remote server (runtime environment) is removed, the renderer
 * also mirrors that host's project groups — rows stamped `executionHostId:
 * runtime:<envId>` that never persist to orca-data.json. Retiring the host's
 * repos/sessions but not its group rows left an empty orphan group in the
 * sidebar that could never be deleted once its owner runtime was gone
 * (stablyai/orca#18364). These cases pin that the removed host's group rows —
 * and the folder workspaces / repo memberships they own — are pruned in the
 * same pass, while local and still-saved sibling-runtime groups survive.
 */
import { describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

import { createTestStore, seedStore, TEST_REPO } from './store-test-helpers'

const RUNTIME_A = toRuntimeExecutionHostId('env-a')
const RUNTIME_B = toRuntimeExecutionHostId('env-b')

function makeGroup(overrides: Partial<ProjectGroup> & { id: string }): ProjectGroup {
  return {
    name: overrides.id,
    parentPath: null,
    connectionId: null,
    executionHostId: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as ProjectGroup
}

function makeFolderWorkspace(
  overrides: Partial<FolderWorkspace> & { id: string; projectGroupId: string }
): FolderWorkspace {
  return {
    name: overrides.id,
    folderPath: '/tmp/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as FolderWorkspace
}

function repoWithId(
  id: string,
  projectGroupId: string | null,
  overrides: Partial<Repo> = {}
): Repo {
  return { ...TEST_REPO, id, displayName: id, projectGroupId, ...overrides }
}

describe('purgeStaleRuntimeHostState project groups', () => {
  it('drops the removed runtime host’s group subtree and preserves local + sibling-runtime groups', () => {
    const store = createTestStore()
    const parentA = makeGroup({ id: 'gA', executionHostId: RUNTIME_A })
    const childA = makeGroup({
      id: 'gA-child',
      executionHostId: RUNTIME_A,
      parentGroupId: parentA.id
    })
    const localGroup = makeGroup({ id: 'gLocal', executionHostId: null })
    const siblingB = makeGroup({ id: 'gB', executionHostId: RUNTIME_B })
    seedStore(store, {
      projectGroups: [parentA, childA, localGroup, siblingB]
    })
    const epochBefore = store.getState().sortEpoch

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.projectGroups.map((group) => group.id).sort()).toEqual(['gB', 'gLocal'])
    expect(s.sortEpoch).toBe(epochBefore + 1)
  })

  it('cascades dropped groups into folder workspaces and surviving repo memberships', () => {
    const store = createTestStore()
    const groupA = makeGroup({ id: 'gA', executionHostId: RUNTIME_A })
    const folderA = makeFolderWorkspace({ id: 'fwA', projectGroupId: groupA.id })
    // Pathological-but-safe: a local repo still pointing at a dropped runtime group.
    const localRepoInGroup = repoWithId('repoLocal', groupA.id, { executionHostId: 'local' })
    seedStore(store, {
      projectGroups: [groupA],
      folderWorkspaces: [folderA],
      repos: [localRepoInGroup]
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.projectGroups).toEqual([])
    expect(s.folderWorkspaces).toEqual([])
    // The repo survives (it is local), but its dangling group membership is cleared.
    expect(s.repos.find((repo) => repo.id === 'repoLocal')?.projectGroupId).toBeNull()
  })

  it('is a no-op for a non-matching env: group rows keep their reference', () => {
    const store = createTestStore()
    const localGroup = makeGroup({ id: 'gLocal', executionHostId: null })
    const siblingB = makeGroup({ id: 'gB', executionHostId: RUNTIME_B })
    seedStore(store, {
      projectGroups: [localGroup, siblingB],
      repos: [repoWithId('repo1', null, { executionHostId: 'local' })]
    })
    const epochBefore = store.getState().sortEpoch
    const groupsRef = store.getState().projectGroups

    store.getState().purgeStaleRuntimeHostState(['env-does-not-exist'])

    const s = store.getState()
    expect(s.projectGroups).toBe(groupsRef)
    expect(s.sortEpoch).toBe(epochBefore)
  })
})
