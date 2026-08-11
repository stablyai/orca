import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  capturedPanesByTabId,
  disposeParkedTabWatchers,
  parkedWatchersByTabId
} from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { registerRuntimeTerminalTab } from '@/runtime/sync-runtime-graph'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { teardownSelectiveFolderWorkspaceOwner } from './folder-workspace-selective-renderer-teardown'
import { createTestStore, makeTab } from './store-test-helpers'

const OWNER_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const runtimeEnvironmentCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'rpc-browser-close',
    ok: true,
    result: { closed: true },
    _meta: { runtimeId: 'browser-owner-runtime' }
  })
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: (request: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(request) ?? runtimeEnvironmentCall(request)
      }
    }
  })
})

afterEach(() => {
  for (const tabId of parkedWatchersByTabId.keys()) {
    disposeParkedTabWatchers(tabId)
  }
  capturedPanesByTabId.clear()
  vi.unstubAllGlobals()
})

describe('selective folder workspace renderer teardown', () => {
  it('closes only the removed owner remote browser page before pruning its handle', async () => {
    const workspaceKey = folderWorkspaceKey('shared-browser')
    const ownerEnvironmentId = 'browser-owner-env'
    const siblingEnvironmentId = 'browser-sibling-env'
    const ownerHostId = toRuntimeExecutionHostId(ownerEnvironmentId)
    const siblingHostId = toRuntimeExecutionHostId(siblingEnvironmentId)
    const ownerWorkspace = {
      id: 'browser-owner',
      worktreeId: workspaceKey,
      workspaceExecutionHostId: ownerHostId
    }
    const siblingWorkspace = {
      id: 'browser-sibling',
      worktreeId: workspaceKey,
      workspaceExecutionHostId: siblingHostId
    }
    const ownerPage = {
      id: 'page-owner',
      workspaceId: ownerWorkspace.id,
      worktreeId: workspaceKey,
      workspaceExecutionHostId: ownerHostId
    }
    const siblingPage = {
      id: 'page-sibling',
      workspaceId: siblingWorkspace.id,
      worktreeId: workspaceKey,
      workspaceExecutionHostId: siblingHostId
    }
    const store = createTestStore()
    store.setState({
      browserTabsByWorktree: {
        [workspaceKey]: [ownerWorkspace, siblingWorkspace] as never
      },
      browserPagesByWorkspace: {
        [ownerWorkspace.id]: [ownerPage] as never,
        [siblingWorkspace.id]: [siblingPage] as never
      },
      remoteBrowserPageHandlesByPageId: {
        [ownerPage.id]: { environmentId: ownerEnvironmentId, remotePageId: 'remote-owner' },
        [siblingPage.id]: {
          environmentId: siblingEnvironmentId,
          remotePageId: 'remote-sibling'
        }
      }
    })

    teardownSelectiveFolderWorkspaceOwner({
      get: store.getState,
      isCurrent: () => true,
      ownerRemoval: {
        kind: 'runtime',
        environmentId: ownerEnvironmentId,
        hostId: ownerHostId,
        workspaceKeys: [workspaceKey]
      },
      retireBrowserWorkspaceIds: [ownerWorkspace.id],
      retireEditorFileIds: [],
      retireTabIds: [],
      retireUnifiedTabIds: [],
      set: (updater) => store.setState(updater),
      workspaceKey
    })

    expect(store.getState().browserTabsByWorktree[workspaceKey]).toEqual([siblingWorkspace])
    expect(store.getState().remoteBrowserPageHandlesByPageId).toEqual({
      [siblingPage.id]: {
        environmentId: siblingEnvironmentId,
        remotePageId: 'remote-sibling'
      }
    })
    await vi.waitFor(() =>
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: ownerEnvironmentId,
          method: 'browser.tabClose',
          params: expect.objectContaining({ page: 'remote-owner' })
        })
      )
    )
    expect(
      runtimeEnvironmentCall.mock.calls.some(
        ([request]) => request.selector === siblingEnvironmentId
      )
    ).toBe(false)
  })

  it('revalidates a captured editor id before pruning a sibling-owned replacement', () => {
    const workspaceKey = folderWorkspaceKey('shared-editor')
    const ownerTargetId = 'ssh-owner'
    const siblingTargetId = 'ssh-sibling'
    const fileId = 'shared-diff-id'
    const unifiedTab = {
      id: 'unified-shared-diff',
      entityId: fileId,
      groupId: 'group-sibling',
      worktreeId: workspaceKey,
      contentType: 'diff'
    }
    const siblingFile = {
      id: fileId,
      filePath: '/sibling/file.ts',
      relativePath: 'file.ts',
      worktreeId: workspaceKey,
      language: 'typescript',
      mode: 'diff',
      operationProvenance: {
        generation: {
          route: {
            executionHostId: toSshExecutionHostId(siblingTargetId),
            runtimeEnvironmentId: null
          }
        }
      }
    }
    const store = createTestStore()
    const closeUnifiedTab = vi.fn()
    store.setState({
      openFiles: [siblingFile] as never,
      unifiedTabsByWorktree: { [workspaceKey]: [unifiedTab] as never },
      closeUnifiedTab: closeUnifiedTab as never
    })

    teardownSelectiveFolderWorkspaceOwner({
      get: store.getState,
      isCurrent: () => true,
      ownerRemoval: {
        kind: 'ssh',
        hostId: toSshExecutionHostId(ownerTargetId),
        targetId: ownerTargetId,
        workspaceKeys: [workspaceKey]
      },
      retireBrowserWorkspaceIds: [],
      retireEditorFileIds: [fileId],
      retireTabIds: [],
      retireUnifiedTabIds: [unifiedTab.id],
      set: (updater) => store.setState(updater),
      workspaceKey
    })

    expect(store.getState().openFiles).toEqual([siblingFile])
    expect(store.getState().unifiedTabsByWorktree[workspaceKey]).toEqual([unifiedTab])
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('cleans a live direct-SSH binding through its mounted pane identity', () => {
    const workspaceKey = folderWorkspaceKey('shared')
    const tabId = 'mixed-tab'
    const ownerTargetId = 'ssh-owner'
    const siblingTargetId = 'ssh-sibling'
    const ownerPtyId = toAppSshPtyId(ownerTargetId, 'owner-pty')
    const siblingPtyId = toAppSshPtyId(siblingTargetId, 'sibling-pty')
    const tab = makeTab({ id: tabId, worktreeId: workspaceKey, ptyId: siblingPtyId })
    const authority = {
      targetId: ownerTargetId,
      providerEpoch: 'epoch' as never,
      connectionGeneration: 1
    }
    const watcherDispose = vi.fn()
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { [workspaceKey]: [tab] },
      ptyIdsByTabId: { [tabId]: [siblingPtyId] },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf', leafId: SIBLING_LEAF_ID },
          activeLeafId: SIBLING_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [SIBLING_LEAF_ID]: siblingPtyId }
        }
      },
      directSshLivePtyBindingByTabId: {
        [tabId]: {
          attemptId: 'attempt' as never,
          authority,
          tabGeneration: 1,
          ptyId: ownerPtyId
        }
      },
      runtimePaneTitlesByTabId: { [tabId]: { 7: 'Owner', 8: 'Sibling' } },
      unreadTerminalTabs: { [tabId]: true },
      codexRestartNoticeByPtyId: {
        [ownerPtyId]: { previousAccountLabel: 'Old', nextAccountLabel: 'New' }
      },
      pendingCodexPaneRestartIds: { [ownerPtyId]: true },
      pendingSnapshotByPtyId: { [ownerPtyId]: { snapshot: 'owner snapshot' } },
      pendingColdRestoreByPtyId: {
        [ownerPtyId]: { scrollback: 'owner scrollback', cwd: '/workspace' }
      }
    })
    parkedWatchersByTabId.set(tabId, {
      worktreeId: workspaceKey,
      tabPtyId: siblingPtyId,
      paneIdByPtyId: new Map([[ownerPtyId, 7]]),
      disposersByPtyId: new Map([[ownerPtyId, watcherDispose]])
    })
    const unregister = registerRuntimeTerminalTab({
      tabId,
      worktreeId: workspaceKey,
      getContainer: () => null,
      getManager: () =>
        ({
          getPanes: () => [
            { id: 7, leafId: OWNER_LEAF_ID },
            { id: 8, leafId: SIBLING_LEAF_ID }
          ]
        }) as never,
      getPtyIdForPane: (paneId) => (paneId === 7 ? ownerPtyId : siblingPtyId)
    })

    try {
      teardownSelectiveFolderWorkspaceOwner({
        get: store.getState,
        isCurrent: () => true,
        ownerRemoval: {
          kind: 'ssh',
          hostId: toSshExecutionHostId(ownerTargetId),
          targetId: ownerTargetId,
          workspaceKeys: [workspaceKey]
        },
        retireBrowserWorkspaceIds: [],
        retireEditorFileIds: [],
        retireTabIds: [],
        retireUnifiedTabIds: [],
        set: (updater) => store.setState(updater),
        workspaceKey
      })
    } finally {
      unregister()
    }

    const state = store.getState()
    expect(state.directSshLivePtyBindingByTabId[tabId]).toBeUndefined()
    expect(state.runtimePaneTitlesByTabId[tabId]).toEqual({ 8: 'Sibling' })
    expect(state.unreadTerminalTabs[tabId]).toBe(true)
    expect(watcherDispose).toHaveBeenCalledOnce()
    expect(state.codexRestartNoticeByPtyId[ownerPtyId]).toBeUndefined()
    expect(state.pendingCodexPaneRestartIds[ownerPtyId]).toBeUndefined()
    expect(state.pendingSnapshotByPtyId[ownerPtyId]).toBeUndefined()
    expect(state.pendingColdRestoreByPtyId[ownerPtyId]).toBeUndefined()
  })
})
