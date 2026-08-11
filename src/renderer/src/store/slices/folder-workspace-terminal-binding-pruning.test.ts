import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { FolderWorkspace, TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { toRemoteRuntimePtyId } from '../../runtime/runtime-terminal-stream'
import type { AppState } from '../types'
import { pruneFolderWorkspaceTerminalBindings } from './folder-workspace-terminal-binding-pruning'
import {
  folderWorkspaceTerminalOwnerOwnsPty,
  reconcileDeletedFolderWorkspaceActiveOwner
} from './folder-workspace-terminal-owner'

type TerminalBindingState = Parameters<typeof pruneFolderWorkspaceTerminalBindings>[0]

const WORKSPACE_ID = 'shared-folder'
const WORKSPACE_KEY = folderWorkspaceKey(WORKSPACE_ID)
const RUNTIME_A_ID = 'runtime-a'
const RUNTIME_B_ID = 'runtime-b'
const RUNTIME_A_HOST_ID = toRuntimeExecutionHostId(RUNTIME_A_ID)
const RUNTIME_B_HOST_ID = toRuntimeExecutionHostId(RUNTIME_B_ID)
const OWNER_TOP_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SURVIVOR_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const OWNER_BOTTOM_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const SIBLING_LEAF_ID = '44444444-4444-4444-8444-444444444444'

function makeTab(id: string, ptyId: string | null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WORKSPACE_KEY,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeBindingState(overrides: Partial<TerminalBindingState>): TerminalBindingState {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    directSshLivePtyBindingByTabId: {},
    directSshPaneRetryByTabId: {},
    directSshPaneRetryHistoryByTabId: {},
    pendingReconnectPtyIdByTabId: {},
    expandedPaneByTabId: {},
    canExpandPaneByTabId: {},
    ...overrides
  }
}

function makeFolderWorkspace(executionHostId: ExecutionHostId): FolderWorkspace {
  return {
    id: WORKSPACE_ID,
    projectGroupId: 'group',
    name: WORKSPACE_ID,
    folderPath: 'workspace',
    executionHostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('folder workspace terminal binding pruning', () => {
  it('collapses mixed runtime leaves and prunes every leaf side map', () => {
    const ownerTopPtyId = toRemoteRuntimePtyId('owner-top', RUNTIME_A_ID)
    const ownerBottomPtyId = toRemoteRuntimePtyId('owner-bottom', RUNTIME_A_ID)
    const ownerIndexedPtyId = toRemoteRuntimePtyId('owner-indexed', RUNTIME_A_ID)
    const ownerTabPtyId = toRemoteRuntimePtyId('owner-tab', RUNTIME_A_ID)
    const ownerLastKnownPtyId = toRemoteRuntimePtyId('owner-last-known', RUNTIME_A_ID)
    const ownerDeferredPtyId = toRemoteRuntimePtyId('owner-deferred', RUNTIME_A_ID)
    const ownerPendingPtyId = toRemoteRuntimePtyId('owner-pending', RUNTIME_A_ID)
    const siblingRuntimePtyId = toRemoteRuntimePtyId('sibling-runtime', RUNTIME_B_ID)
    const siblingTabPtyId = toRemoteRuntimePtyId('sibling-tab', RUNTIME_B_ID)
    const localPtyId = 'local-pty'
    const targetTab = makeTab('target-tab', ownerTabPtyId)
    const siblingTab = makeTab('sibling-tab', siblingTabPtyId)
    const targetLayout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.4,
        first: { type: 'leaf', leafId: OWNER_TOP_LEAF_ID },
        second: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.6,
          first: { type: 'leaf', leafId: SURVIVOR_LEAF_ID },
          second: { type: 'leaf', leafId: OWNER_BOTTOM_LEAF_ID }
        }
      },
      activeLeafId: OWNER_BOTTOM_LEAF_ID,
      expandedLeafId: OWNER_TOP_LEAF_ID,
      ptyIdsByLeafId: {
        [OWNER_TOP_LEAF_ID]: ownerTopPtyId,
        [SURVIVOR_LEAF_ID]: siblingRuntimePtyId,
        [OWNER_BOTTOM_LEAF_ID]: ownerBottomPtyId
      },
      buffersByLeafId: {
        [OWNER_TOP_LEAF_ID]: 'owner top buffer',
        [SURVIVOR_LEAF_ID]: 'survivor buffer',
        [OWNER_BOTTOM_LEAF_ID]: 'owner bottom buffer'
      },
      scrollbackRefsByLeafId: {
        [OWNER_TOP_LEAF_ID]: 'owner-top-ref',
        [SURVIVOR_LEAF_ID]: 'survivor-ref',
        [OWNER_BOTTOM_LEAF_ID]: 'owner-bottom-ref'
      },
      titlesByLeafId: {
        [OWNER_TOP_LEAF_ID]: 'Owner top',
        [SURVIVOR_LEAF_ID]: 'Survivor',
        [OWNER_BOTTOM_LEAF_ID]: 'Owner bottom'
      }
    }
    const siblingLayout: TerminalLayoutSnapshot = {
      root: { type: 'leaf', leafId: SIBLING_LEAF_ID },
      activeLeafId: SIBLING_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [SIBLING_LEAF_ID]: siblingTabPtyId }
    }
    const siblingIndexedPtyIds = [siblingTabPtyId, localPtyId]
    const state = makeBindingState({
      tabsByWorktree: { [WORKSPACE_KEY]: [targetTab, siblingTab] },
      ptyIdsByTabId: {
        [targetTab.id]: [localPtyId, ownerIndexedPtyId, siblingRuntimePtyId],
        [siblingTab.id]: siblingIndexedPtyIds
      },
      terminalLayoutsByTabId: {
        [targetTab.id]: targetLayout,
        [siblingTab.id]: siblingLayout
      },
      lastKnownRelayPtyIdByTabId: {
        [targetTab.id]: ownerLastKnownPtyId,
        [siblingTab.id]: siblingTabPtyId
      },
      deferredSshSessionIdsByTabId: {
        [targetTab.id]: ownerDeferredPtyId,
        [siblingTab.id]: siblingTabPtyId
      },
      pendingReconnectPtyIdByTabId: {
        [targetTab.id]: ownerPendingPtyId,
        [siblingTab.id]: siblingTabPtyId
      },
      expandedPaneByTabId: {
        [targetTab.id]: true,
        [siblingTab.id]: true
      },
      canExpandPaneByTabId: {
        [targetTab.id]: true,
        [siblingTab.id]: true
      }
    })
    const originalState = structuredClone(state)

    const result = pruneFolderWorkspaceTerminalBindings(state, WORKSPACE_KEY, {
      kind: 'runtime',
      environmentId: RUNTIME_A_ID
    })

    expect(state).toEqual(originalState)
    expect(new Set(result.removedPtyIds)).toEqual(
      new Set([
        ownerTopPtyId,
        ownerBottomPtyId,
        ownerIndexedPtyId,
        ownerTabPtyId,
        ownerLastKnownPtyId,
        ownerDeferredPtyId,
        ownerPendingPtyId
      ])
    )
    expect(new Set(result.removedPaneKeys)).toEqual(
      new Set([
        makePaneKey(targetTab.id, OWNER_TOP_LEAF_ID),
        makePaneKey(targetTab.id, OWNER_BOTTOM_LEAF_ID)
      ])
    )
    expect(result.patch).not.toBeNull()
    const patch = result.patch!
    expect(patch.tabsByWorktree?.[WORKSPACE_KEY]).toEqual([
      { ...targetTab, ptyId: siblingRuntimePtyId },
      siblingTab
    ])
    expect(patch.tabsByWorktree?.[WORKSPACE_KEY]?.[1]).toBe(siblingTab)
    expect(patch.ptyIdsByTabId).toEqual({
      [targetTab.id]: [localPtyId, siblingRuntimePtyId],
      [siblingTab.id]: siblingIndexedPtyIds
    })
    expect(patch.ptyIdsByTabId?.[siblingTab.id]).toBe(siblingIndexedPtyIds)
    expect(patch.terminalLayoutsByTabId?.[targetTab.id]).toEqual({
      root: { type: 'leaf', leafId: SURVIVOR_LEAF_ID },
      activeLeafId: SURVIVOR_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [SURVIVOR_LEAF_ID]: siblingRuntimePtyId },
      buffersByLeafId: { [SURVIVOR_LEAF_ID]: 'survivor buffer' },
      scrollbackRefsByLeafId: { [SURVIVOR_LEAF_ID]: 'survivor-ref' },
      titlesByLeafId: { [SURVIVOR_LEAF_ID]: 'Survivor' }
    })
    expect(patch.terminalLayoutsByTabId?.[siblingTab.id]).toBe(siblingLayout)
    expect(patch.lastKnownRelayPtyIdByTabId).toEqual({
      [targetTab.id]: siblingRuntimePtyId,
      [siblingTab.id]: siblingTabPtyId
    })
    expect(patch.deferredSshSessionIdsByTabId).toEqual({
      [siblingTab.id]: siblingTabPtyId
    })
    expect(patch.pendingReconnectPtyIdByTabId).toEqual({
      [siblingTab.id]: siblingTabPtyId
    })
    expect(patch.expandedPaneByTabId).toEqual({ [siblingTab.id]: true })
    expect(patch.canExpandPaneByTabId).toEqual({ [siblingTab.id]: true })
  })

  it('recomputes expansion flags when multiple sibling leaves survive', () => {
    const ownerPtyId = toRemoteRuntimePtyId('owner', RUNTIME_A_ID)
    const siblingPtyId = toRemoteRuntimePtyId('sibling', RUNTIME_B_ID)
    const otherSiblingPtyId = 'local-pty'
    const tab = makeTab('mixed-tab', siblingPtyId)
    const state = makeBindingState({
      tabsByWorktree: { [WORKSPACE_KEY]: [tab] },
      ptyIdsByTabId: { [tab.id]: [ownerPtyId, siblingPtyId, otherSiblingPtyId] },
      terminalLayoutsByTabId: {
        [tab.id]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: OWNER_TOP_LEAF_ID },
            second: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: SURVIVOR_LEAF_ID },
              second: { type: 'leaf', leafId: SIBLING_LEAF_ID }
            }
          },
          activeLeafId: SURVIVOR_LEAF_ID,
          expandedLeafId: SURVIVOR_LEAF_ID,
          ptyIdsByLeafId: {
            [OWNER_TOP_LEAF_ID]: ownerPtyId,
            [SURVIVOR_LEAF_ID]: siblingPtyId,
            [SIBLING_LEAF_ID]: otherSiblingPtyId
          }
        }
      },
      expandedPaneByTabId: { [tab.id]: false },
      canExpandPaneByTabId: { [tab.id]: false }
    })

    const result = pruneFolderWorkspaceTerminalBindings(state, WORKSPACE_KEY, {
      kind: 'runtime',
      environmentId: RUNTIME_A_ID
    })

    expect(result.patch?.terminalLayoutsByTabId?.[tab.id]?.expandedLeafId).toBe(SURVIVOR_LEAF_ID)
    expect(result.patch?.expandedPaneByTabId).toEqual({ [tab.id]: true })
    expect(result.patch?.canExpandPaneByTabId).toEqual({ [tab.id]: true })
  })

  it('classifies exact SSH owners without claiming sibling SSH or local PTYs', () => {
    const sshAOwner = { kind: 'ssh', targetId: 'target/a' } as const
    const sshAPtyId = toAppSshPtyId(sshAOwner.targetId, 'pty-a')
    const sshBPtyId = toAppSshPtyId('target/a-sibling', 'pty-b')
    const localPtyId = 'local-pty'

    expect(folderWorkspaceTerminalOwnerOwnsPty(sshAOwner, sshAPtyId)).toBe(true)
    expect(folderWorkspaceTerminalOwnerOwnsPty(sshAOwner, sshBPtyId)).toBe(false)
    expect(folderWorkspaceTerminalOwnerOwnsPty(sshAOwner, localPtyId)).toBe(false)
    expect(folderWorkspaceTerminalOwnerOwnsPty({ kind: 'local' }, localPtyId)).toBe(true)
    expect(folderWorkspaceTerminalOwnerOwnsPty({ kind: 'local' }, sshAPtyId)).toBe(false)
    expect(folderWorkspaceTerminalOwnerOwnsPty({ kind: 'local' }, sshBPtyId)).toBe(false)
  })

  it('drops exact SSH recovery records without claiming a sibling binding', () => {
    const targetId = 'target-a'
    const siblingPtyId = toAppSshPtyId('target-b', 'sibling-pty')
    const staleTargetPtyId = toAppSshPtyId(targetId, 'stale-target-pty')
    const tab = makeTab('ssh-recovery-tab', siblingPtyId)
    const authority = {
      targetId,
      providerEpoch: 'provider-epoch' as never,
      connectionGeneration: 1
    }
    const state = makeBindingState({
      tabsByWorktree: { [WORKSPACE_KEY]: [tab] },
      ptyIdsByTabId: { [tab.id]: [siblingPtyId] },
      directSshPaneRetryByTabId: {
        [tab.id]: {
          attemptId: 'attempt' as never,
          authority,
          tabGeneration: 1,
          startedAt: 1
        }
      },
      directSshLivePtyBindingByTabId: {
        [tab.id]: {
          attemptId: 'attempt' as never,
          authority,
          tabGeneration: 1,
          ptyId: staleTargetPtyId
        }
      },
      directSshPaneRetryHistoryByTabId: {
        [tab.id]: { authority, attemptedAt: [1] }
      }
    })

    const result = pruneFolderWorkspaceTerminalBindings(state, WORKSPACE_KEY, {
      kind: 'ssh',
      targetId
    })

    expect(result.removedPtyIds).toEqual([staleTargetPtyId])
    expect(result.patch).toMatchObject({
      directSshPaneRetryByTabId: {},
      directSshLivePtyBindingByTabId: {},
      directSshPaneRetryHistoryByTabId: {}
    })
    expect(result.patch?.tabsByWorktree).toBeUndefined()
    expect(state.tabsByWorktree[WORKSPACE_KEY]).toEqual([tab])
  })

  it('retargets active and restored ownership to one surviving runtime host', () => {
    const untouchedKey = folderWorkspaceKey('untouched')
    const untouchedHostId = toRuntimeExecutionHostId('untouched-runtime')
    const restoredOwners = {
      [WORKSPACE_KEY]: RUNTIME_A_HOST_ID,
      [untouchedKey]: untouchedHostId
    }
    const state = {
      folderWorkspaces: [makeFolderWorkspace(RUNTIME_B_HOST_ID)],
      projectGroups: [],
      activeWorktreeId: WORKSPACE_KEY,
      activeWorkspaceKey: WORKSPACE_KEY,
      activeWorkspaceExecutionHostId: RUNTIME_A_HOST_ID,
      restoredRuntimeHostIdByWorkspaceSessionKey: restoredOwners
    } as unknown as AppState

    const patch = reconcileDeletedFolderWorkspaceActiveOwner(
      state,
      WORKSPACE_KEY,
      RUNTIME_A_HOST_ID
    )

    expect(patch).toEqual({
      activeWorkspaceExecutionHostId: RUNTIME_B_HOST_ID,
      restoredRuntimeHostIdByWorkspaceSessionKey: {
        [WORKSPACE_KEY]: RUNTIME_B_HOST_ID,
        [untouchedKey]: untouchedHostId
      }
    })
    expect(state.restoredRuntimeHostIdByWorkspaceSessionKey).toBe(restoredOwners)
  })

  it('clears active and restored ownership when no host survives', () => {
    const untouchedKey = folderWorkspaceKey('untouched')
    const untouchedHostId = toRuntimeExecutionHostId('untouched-runtime')
    const state = {
      folderWorkspaces: [],
      projectGroups: [],
      activeWorktreeId: WORKSPACE_KEY,
      activeWorkspaceKey: WORKSPACE_KEY,
      activeWorkspaceExecutionHostId: RUNTIME_A_HOST_ID,
      activeTabId: 'terminal-tab',
      activeBrowserTabId: 'browser-tab',
      activeFileId: 'file-tab',
      activeTabType: 'browser',
      restoredRuntimeHostIdByWorkspaceSessionKey: {
        [WORKSPACE_KEY]: RUNTIME_A_HOST_ID,
        [untouchedKey]: untouchedHostId
      }
    } as unknown as AppState

    expect(
      reconcileDeletedFolderWorkspaceActiveOwner(state, WORKSPACE_KEY, RUNTIME_A_HOST_ID)
    ).toEqual({
      activeWorktreeId: null,
      activeWorkspaceKey: null,
      activeWorkspaceExecutionHostId: null,
      activeTabId: null,
      activeBrowserTabId: null,
      activeFileId: null,
      activeTabType: 'terminal',
      restoredRuntimeHostIdByWorkspaceSessionKey: { [untouchedKey]: untouchedHostId }
    })
  })
})
