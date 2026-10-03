import { beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreActiveServerWorkspace } from './active-server-workspace-selection'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  createTestStore,
  makeWorktree,
  makeTab,
  makeUnifiedTab,
  makeTabGroup,
  seedStore
} from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
const api = createStoreCascadesMockApi()
const work = makeWorktree({ id: 'work::/project', repoId: 'work', hostId: 'runtime:work' })
const priv = makeWorktree({ id: 'priv::/project', repoId: 'priv', hostId: 'runtime:priv' })

function seededStore() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { work: [work], priv: [priv] },
    lastVisitedAtByWorktreeId: {
      [composeWorktreeHostIdentity(work.hostId, work.id)]: 1,
      [composeWorktreeHostIdentity(priv.hostId, priv.id)]: 2
    },
    everActivatedWorktreeIds: new Set([work.id, priv.id]),
    refreshGitHubForWorktree: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn()
  })
  for (const workspace of [work, priv]) {
    const tabId = `${workspace.repoId}-terminal`
    const groupId = `${workspace.repoId}-group`
    store.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [workspace.id]: [makeTab({ id: tabId, worktreeId: workspace.id, ptyId: `${tabId}-pty` })]
      },
      ptyIdsByTabId: { ...state.ptyIdsByTabId, [tabId]: [`${tabId}-pty`] },
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [workspace.id]: [
          makeUnifiedTab({
            id: tabId,
            entityId: tabId,
            worktreeId: workspace.id,
            groupId,
            contentType: 'terminal'
          })
        ]
      },
      groupsByWorktree: {
        ...state.groupsByWorktree,
        [workspace.id]: [
          makeTabGroup({
            id: groupId,
            worktreeId: workspace.id,
            activeTabId: tabId,
            tabOrder: [tabId]
          })
        ]
      },
      activeTabIdByWorktree: { ...state.activeTabIdByWorktree, [workspace.id]: tabId }
    }))
  }
  return store
}

beforeEach(() => vi.clearAllMocks())

describe('restoreActiveServerWorkspace', () => {
  it('restores each host terminal and preserves the other host sessions', () => {
    const store = seededStore()
    const before = store.getState().tabsByWorktree
    restoreActiveServerWorkspace(store.getState(), 'runtime:work')
    expect(store.getState()).toMatchObject({
      activeWorktreeId: work.id,
      activeTabId: 'work-terminal',
      activeWorkspaceExecutionHostId: 'runtime:work'
    })
    restoreActiveServerWorkspace(store.getState(), 'runtime:priv')
    expect(store.getState()).toMatchObject({
      activeWorktreeId: priv.id,
      activeTabId: 'priv-terminal',
      activeWorkspaceExecutionHostId: 'runtime:priv'
    })
    restoreActiveServerWorkspace(store.getState(), 'runtime:work')
    expect(store.getState().activeTabId).toBe('work-terminal')
    expect(store.getState().tabsByWorktree).toBe(before)
    expect(api.pty.kill).not.toHaveBeenCalled()
  })

  it('clears the visible workspace for an unvisited host without deleting terminals', () => {
    const store = seededStore()
    restoreActiveServerWorkspace(store.getState(), 'runtime:work')
    const before = store.getState().tabsByWorktree
    restoreActiveServerWorkspace(store.getState(), 'local')
    expect(store.getState()).toMatchObject({
      activeWorktreeId: null,
      activeRepoId: null,
      activeWorkspaceExecutionHostId: null
    })
    expect(store.getState().tabsByWorktree).toBe(before)
    expect(api.pty.kill).not.toHaveBeenCalled()
  })

  it('ignores other-host visits, removed workspaces and archived workspaces', () => {
    const store = seededStore()
    store.setState({
      lastVisitedAtByWorktreeId: {
        [composeWorktreeHostIdentity('runtime:priv', work.id)]: 100,
        [composeWorktreeHostIdentity('runtime:work', 'removed')]: 101
      }
    })
    restoreActiveServerWorkspace(store.getState(), 'runtime:work')
    expect(store.getState().activeWorktreeId).toBeNull()
    store.setState({
      worktreesByRepo: { work: [{ ...work, isArchived: true }] },
      lastVisitedAtByWorktreeId: { [composeWorktreeHostIdentity(work.hostId, work.id)]: 102 }
    })
    restoreActiveServerWorkspace(store.getState(), 'runtime:work')
    expect(store.getState().activeWorktreeId).toBeNull()
  })

  it('restores folder workspaces through their existing tab selection', () => {
    const store = seededStore()
    const folder = makeFolderWorkspace({ id: 'folder-1', executionHostId: 'runtime:priv' })
    const key = folderWorkspaceKey(folder.id)
    store.setState({
      folderWorkspaces: [folder],
      lastVisitedAtByWorktreeId: { [composeWorktreeHostIdentity('runtime:priv', key)]: 10 }
    })
    const tab = store.getState().createTab(key)
    restoreActiveServerWorkspace(store.getState(), 'runtime:priv')
    expect(store.getState()).toMatchObject({
      activeWorktreeId: key,
      activeTabId: tab.id,
      activeTabType: 'terminal',
      activeWorkspaceExecutionHostId: 'runtime:priv'
    })
  })
})
