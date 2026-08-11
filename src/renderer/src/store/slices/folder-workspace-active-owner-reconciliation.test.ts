import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  createCompatibleRuntimeStatusResponse,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import type { AppState } from '../types'
import { reconcileDeletedFolderWorkspaceActiveOwner } from './folder-workspace-terminal-owner'
import { createTestStore, makeTab } from './store-test-helpers'

vi.mock('@/components/terminal-pane/terminal-parked-watcher-registry', () => ({
  capturedPanesByTabId: new Map(),
  disposeParkedTerminalWatchersForPtyIds: vi.fn(),
  disposeRemovedWorktreeParkedTerminalWatchers: vi.fn(),
  retireParkedTerminalTab: vi.fn()
}))

const runtimeEnvironmentCall = vi.fn()

const rootGroup: ProjectGroup = {
  id: 'root-group',
  name: 'Root',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1,
  executionHostId: 'local'
}

function makeFolderWorkspace(
  id: string,
  overrides: Partial<FolderWorkspace> = {}
): FolderWorkspace {
  return {
    id,
    projectGroupId: rootGroup.id,
    name: id,
    folderPath: `/workspace/${id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

function instrumentRendererTeardown(store: ReturnType<typeof createTestStore>) {
  const shutdownWorktreeBrowsers = vi.fn().mockResolvedValue(undefined)
  const shutdownWorktreeTerminals = vi.fn().mockResolvedValue(undefined)
  const purgeWorktreeTerminalState = vi.fn(store.getState().purgeWorktreeTerminalState)
  store.setState({
    shutdownWorktreeBrowsers,
    shutdownWorktreeTerminals,
    purgeWorktreeTerminalState
  })
  return { purgeWorktreeTerminalState }
}

function mockRuntimeFolderCatalog(): void {
  const status = createCompatibleRuntimeStatusResponse('runtime-owner')
  runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
    if (request.method === 'status.get') {
      return status
    }
    if (request.method === 'folderWorkspace.list') {
      return {
        id: 'rpc-folder-list',
        ok: true,
        result: { folderWorkspaces: [] },
        _meta: { runtimeId: 'runtime-owner' }
      }
    }
    throw new Error(`Unexpected runtime method: ${request.method}`)
  })
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { call: runtimeEnvironmentCall } }
  })
})

describe('folder workspace active owner reconciliation', () => {
  it('selects the stable first host when multiple owners survive', () => {
    const workspaceId = 'multi-survivor'
    const workspaceKey = folderWorkspaceKey(workspaceId)
    const removedHostId = toRuntimeExecutionHostId('removed-runtime')
    const firstHostId = toRuntimeExecutionHostId('a-runtime')
    const laterHostId = toRuntimeExecutionHostId('z-runtime')
    const state = {
      folderWorkspaces: [
        makeFolderWorkspace(workspaceId, { executionHostId: laterHostId }),
        makeFolderWorkspace(workspaceId, { executionHostId: firstHostId })
      ],
      projectGroups: [],
      activeWorktreeId: workspaceKey,
      activeWorkspaceKey: workspaceKey,
      activeWorkspaceExecutionHostId: removedHostId,
      restoredRuntimeHostIdByWorkspaceSessionKey: { [workspaceKey]: removedHostId }
    } as unknown as AppState

    expect(reconcileDeletedFolderWorkspaceActiveOwner(state, workspaceKey, removedHostId)).toEqual({
      activeWorkspaceExecutionHostId: firstHostId,
      restoredRuntimeHostIdByWorkspaceSessionKey: { [workspaceKey]: firstHostId }
    })
  })

  it('retires only the active owner unbound tab and retargets a same-key sibling', async () => {
    const environmentId = 'env-unbound-owner'
    const siblingEnvironmentId = 'env-unbound-sibling'
    const ownerHostId = toRuntimeExecutionHostId(environmentId)
    const siblingHostId = toRuntimeExecutionHostId(siblingEnvironmentId)
    const owner = makeFolderWorkspace('unbound-shared', { executionHostId: ownerHostId })
    const sibling = makeFolderWorkspace('unbound-shared', {
      name: 'Unbound sibling',
      executionHostId: siblingHostId
    })
    const workspaceKey = folderWorkspaceKey(owner.id)
    const ownerTab = makeTab({ id: 'tab-unbound-owner', worktreeId: workspaceKey })
    const siblingTab = makeTab({ id: 'tab-unbound-sibling', worktreeId: workspaceKey })
    mockRuntimeFolderCatalog()
    const store = createTestStore()
    store.setState({
      projectGroups: [
        { ...rootGroup, executionHostId: ownerHostId },
        { ...rootGroup, executionHostId: siblingHostId }
      ],
      folderWorkspaces: [owner, sibling],
      activeWorktreeId: workspaceKey,
      activeWorkspaceKey: workspaceKey,
      activeWorkspaceExecutionHostId: ownerHostId,
      activeTabId: ownerTab.id,
      tabsByWorktree: { [workspaceKey]: [ownerTab, siblingTab] }
    })
    const teardown = instrumentRendererTeardown(store)

    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })

    expect(teardown.purgeWorktreeTerminalState).not.toHaveBeenCalled()
    expect(store.getState().folderWorkspaces).toEqual([sibling])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([siblingTab])
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(siblingHostId)
  })

  it('preserves an active same-key sibling unbound tab over stale restored ownership', async () => {
    const environmentId = 'env-stale-restored-owner'
    const siblingEnvironmentId = 'env-active-sibling'
    const ownerHostId = toRuntimeExecutionHostId(environmentId)
    const siblingHostId = toRuntimeExecutionHostId(siblingEnvironmentId)
    const owner = makeFolderWorkspace('stale-owner-shared', { executionHostId: ownerHostId })
    const sibling = makeFolderWorkspace('stale-owner-shared', {
      name: 'Active sibling',
      executionHostId: siblingHostId
    })
    const workspaceKey = folderWorkspaceKey(owner.id)
    const siblingTab = makeTab({ id: 'tab-active-sibling', worktreeId: workspaceKey })
    mockRuntimeFolderCatalog()
    const store = createTestStore()
    store.setState({
      projectGroups: [
        { ...rootGroup, executionHostId: ownerHostId },
        { ...rootGroup, executionHostId: siblingHostId }
      ],
      folderWorkspaces: [owner, sibling],
      activeWorktreeId: workspaceKey,
      activeWorkspaceKey: workspaceKey,
      activeWorkspaceExecutionHostId: siblingHostId,
      activeTabId: siblingTab.id,
      restoredRuntimeHostIdByWorkspaceSessionKey: { [workspaceKey]: ownerHostId },
      tabsByWorktree: { [workspaceKey]: [siblingTab] }
    })
    const teardown = instrumentRendererTeardown(store)

    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })

    expect(teardown.purgeWorktreeTerminalState).not.toHaveBeenCalled()
    expect(store.getState().folderWorkspaces).toEqual([sibling])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([siblingTab])
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(siblingHostId)
  })

  it('uses restored ownership for an active unbound tab with no explicit host', async () => {
    const environmentId = 'env-restored-owner'
    const siblingEnvironmentId = 'env-restored-sibling'
    const ownerHostId = toRuntimeExecutionHostId(environmentId)
    const siblingHostId = toRuntimeExecutionHostId(siblingEnvironmentId)
    const owner = makeFolderWorkspace('restored-owner-shared', { executionHostId: ownerHostId })
    const sibling = makeFolderWorkspace('restored-owner-shared', {
      name: 'Restored sibling',
      executionHostId: siblingHostId
    })
    const workspaceKey = folderWorkspaceKey(owner.id)
    const ownerTab = makeTab({ id: 'tab-restored-owner', worktreeId: workspaceKey })
    const siblingTab = makeTab({ id: 'tab-restored-sibling', worktreeId: workspaceKey })
    mockRuntimeFolderCatalog()
    const store = createTestStore()
    store.setState({
      projectGroups: [
        { ...rootGroup, executionHostId: ownerHostId },
        { ...rootGroup, executionHostId: siblingHostId }
      ],
      folderWorkspaces: [owner, sibling],
      activeWorktreeId: workspaceKey,
      activeWorkspaceKey: workspaceKey,
      activeWorkspaceExecutionHostId: null,
      activeTabId: ownerTab.id,
      restoredRuntimeHostIdByWorkspaceSessionKey: { [workspaceKey]: ownerHostId },
      tabsByWorktree: { [workspaceKey]: [ownerTab, siblingTab] }
    })

    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })

    expect(store.getState().folderWorkspaces).toEqual([sibling])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([siblingTab])
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(siblingHostId)
  })
})
