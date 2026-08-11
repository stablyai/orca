import {
  capturedPanesByTabId,
  disposeParkedTerminalWatchersForPtyIds
} from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { resolveMountedRuntimeTerminalPaneIdByPtyId } from '@/runtime/sync-runtime-graph'
import type { AppState } from '../types'
import { closeRemoteBrowserPagesForWorkspaces } from './browser-remote-page-close'
import { destroyWorkspaceWebviews } from './browser-webview-cleanup'
import { snapshotFolderWorkspaceContentRemoval } from './folder-workspace-content-removal-snapshot'
import { pruneFolderWorkspaceContentState } from './folder-workspace-content-state-pruning'
import { pruneFolderWorkspaceTerminalBindings } from './folder-workspace-terminal-binding-pruning'
import {
  folderWorkspaceTerminalTabBelongsToOwner,
  reconcileDeletedFolderWorkspaceActiveOwner
} from './folder-workspace-terminal-owner'
import type { FolderWorkspaceRendererOwnerRemoval } from './folder-workspace-renderer-teardown'

type TeardownSet = (updater: (state: AppState) => AppState | Partial<AppState>) => void

function resolveRemovedRuntimePaneId(tabId: string, ptyId: string): number | null {
  const mounted = resolveMountedRuntimeTerminalPaneIdByPtyId(tabId, ptyId)
  if (mounted.status === 'resolved') {
    return mounted.paneId
  }
  if (mounted.status === 'missing') {
    return null
  }
  return (
    capturedPanesByTabId.get(tabId)?.panes.find((candidate) => candidate.ptyId === ptyId)?.paneId ??
    null
  )
}

export function teardownSelectiveFolderWorkspaceOwner(args: {
  get: () => AppState
  isCurrent: () => boolean
  ownerRemoval: FolderWorkspaceRendererOwnerRemoval | null
  retireBrowserWorkspaceIds: readonly string[]
  retireEditorFileIds: readonly string[]
  retireTabIds: readonly string[]
  retireUnifiedTabIds: readonly string[]
  set: TeardownSet
  workspaceKey: string
}): void {
  for (const tabId of args.retireTabIds) {
    if (!args.isCurrent()) {
      return
    }
    if (
      !args.ownerRemoval ||
      !folderWorkspaceTerminalTabBelongsToOwner(
        args.get(),
        args.workspaceKey,
        tabId,
        args.ownerRemoval,
        args.ownerRemoval.hostId
      )
    ) {
      continue
    }
    args.get().closeTab(tabId, {
      reason: 'cleanup',
      remoteCloseOwnedByHost: true,
      localPtyTeardownOwnedExternally: true
    })
  }
  if (!args.ownerRemoval || !args.isCurrent()) {
    return
  }
  const contentRemoval = snapshotFolderWorkspaceContentRemoval(
    args.get(),
    args.workspaceKey,
    args.ownerRemoval
  )
  closeRemoteBrowserPagesForWorkspaces(args.get(), contentRemoval.retireBrowserWorkspaceIds)
  for (const workspaceId of contentRemoval.retireBrowserWorkspaceIds) {
    if (!args.isCurrent()) {
      return
    }
    destroyWorkspaceWebviews(args.get().browserPagesByWorkspace, workspaceId)
  }
  const hasRetiredContent =
    contentRemoval.retireBrowserWorkspaceIds.length > 0 ||
    contentRemoval.retireEditorFileIds.length > 0 ||
    contentRemoval.retireUnifiedTabIds.length > 0
  args.set((state) =>
    args.isCurrent()
      ? pruneFolderWorkspaceContentState(state, {
          browserWorkspaceIds: contentRemoval.retireBrowserWorkspaceIds,
          editorFileIds: contentRemoval.retireEditorFileIds,
          ownerRemoval: args.ownerRemoval!,
          unifiedTabIds: contentRemoval.retireUnifiedTabIds,
          workspaceKey: args.workspaceKey
        })
      : state
  )
  if (hasRetiredContent) {
    for (const tabId of contentRemoval.retireUnifiedTabIds) {
      if (!args.isCurrent()) {
        return
      }
      args.get().closeUnifiedTab(tabId, {
        preserveWorkspaceSelection: true,
        recordInteraction: false
      })
    }
    if (args.isCurrent()) {
      args.get().reconcileWorktreeTabModel(args.workspaceKey)
    }
  }
  let removedPaneKeys: string[] = []
  let removedPtyBindings: { ptyId: string; tabId: string }[] = []
  let removedPtyIds: string[] = []
  args.set((state) => {
    if (!args.isCurrent()) {
      return state
    }
    const result = pruneFolderWorkspaceTerminalBindings(
      state,
      args.workspaceKey,
      args.ownerRemoval!
    )
    removedPaneKeys = result.removedPaneKeys
    removedPtyBindings = result.removedPtyBindings
    removedPtyIds = result.removedPtyIds
    const activeOwnerPatch = reconcileDeletedFolderWorkspaceActiveOwner(
      state,
      args.workspaceKey,
      args.ownerRemoval!.hostId
    )
    return result.patch || activeOwnerPatch ? { ...result.patch, ...activeOwnerPatch } : state
  })
  if (removedPtyIds.length > 0 && args.isCurrent()) {
    for (const { ptyId, tabId } of removedPtyBindings) {
      const paneId = resolveRemovedRuntimePaneId(tabId, ptyId)
      if (paneId !== null) {
        args.get().clearRuntimePaneTitle(tabId, paneId)
      }
    }
    disposeParkedTerminalWatchersForPtyIds(removedPtyIds)
    for (const ptyId of removedPtyIds) {
      args.get().clearCodexRestartNotice(ptyId)
      args.get().consumePendingSnapshot(ptyId)
      args.get().consumePendingColdRestore(ptyId)
    }
  }
  if (args.isCurrent()) {
    removedPaneKeys.forEach((paneKey) => args.get().retireAgentPaneAuthority(paneKey))
  }
}
