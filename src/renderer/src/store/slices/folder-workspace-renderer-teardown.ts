import type { ExecutionHostId } from '../../../../shared/execution-host'
import { disposeRemovedWorktreeParkedTerminalWatchers } from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import type { AppState } from '../types'
import {
  closeLegacyRuntimeCatalogTerminals,
  type FolderWorkspaceRuntimeTerminalRemoval
} from './folder-workspace-legacy-terminal-close'
import { snapshotFolderWorkspaceContentRemoval } from './folder-workspace-content-removal-snapshot'
import { teardownSelectiveFolderWorkspaceOwner } from './folder-workspace-selective-renderer-teardown'
import {
  collectFolderWorkspaceTerminalTabPtyIds,
  folderWorkspaceTerminalTabBelongsToOwner
} from './folder-workspace-terminal-owner'

export type FolderWorkspaceRendererTeardownSnapshot = {
  workspaceKey: string
  ptyIds: string[]
  purgeRendererState: boolean
  retireBrowserWorkspaceIds: string[]
  retireEditorFileIds: string[]
  retireTabIds: string[]
  retireUnifiedTabIds: string[]
  ownerRemoval: FolderWorkspaceRendererOwnerRemoval | null
  runtimeCatalogRemoval: FolderWorkspaceRuntimeTerminalRemoval | null
}

export type FolderWorkspaceRendererOwnerRemoval =
  | {
      kind: 'local'
      hostId: ExecutionHostId
      workspaceKeys: readonly string[]
    }
  | {
      kind: 'ssh'
      hostId: ExecutionHostId
      targetId: string
      workspaceKeys: readonly string[]
    }
  | {
      kind: 'runtime'
      environmentId: string
      expectedEnvironmentPairingRevision?: number
      hostId: ExecutionHostId
      workspaceKeys: readonly string[]
      closeLegacyRuntimeTerminals?: boolean
    }

type FolderWorkspaceRendererTeardownSnapshotState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'lastKnownRelayPtyIdByTabId'
  | 'deferredSshSessionIdsByTabId'
  | 'directSshLivePtyBindingByTabId'
  | 'pendingReconnectPtyIdByTabId'
  | 'activeWorktreeId'
  | 'activeWorkspaceKey'
  | 'activeWorkspaceExecutionHostId'
  | 'activeTabId'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
> &
  Partial<
    Pick<
      AppState,
      | 'browserTabsByWorktree'
      | 'browserPagesByWorkspace'
      | 'remoteBrowserPageHandlesByPageId'
      | 'openFiles'
      | 'unifiedTabsByWorktree'
    >
  >

type FolderWorkspaceRendererTeardownSet = (
  updater: (state: AppState) => AppState | Partial<AppState>
) => void

function getRuntimeTerminalHandlesFromPtyIds(
  ptyIds: readonly string[],
  environmentId: string
): string[] {
  return [
    ...new Set(
      ptyIds.flatMap((ptyId) => {
        const remote = parseRemoteRuntimePtyId(ptyId)
        return remote?.environmentId === environmentId && remote.handle ? [remote.handle] : []
      })
    )
  ]
}

export function snapshotFolderWorkspaceRuntimeTerminalHandles(
  state: FolderWorkspaceRendererTeardownSnapshotState,
  workspaceKeys: readonly string[],
  environmentId: string
): string[] {
  return getRuntimeTerminalHandlesFromPtyIds(
    [
      ...new Set(
        workspaceKeys.flatMap((workspaceKey) =>
          (state.tabsByWorktree[workspaceKey] ?? []).flatMap((tab) =>
            collectFolderWorkspaceTerminalTabPtyIds(state, tab)
          )
        )
      )
    ],
    environmentId
  )
}

export function snapshotFolderWorkspaceRendererTeardown(
  state: FolderWorkspaceRendererTeardownSnapshotState,
  purgeWorkspaceKeys: readonly string[],
  ownerRemoval?: FolderWorkspaceRendererOwnerRemoval
): FolderWorkspaceRendererTeardownSnapshot[] {
  const purgeKeys = new Set(purgeWorkspaceKeys)
  const ownerRemovalKeys = new Set(ownerRemoval?.workspaceKeys ?? [])
  const runtimeCatalogRemoval =
    ownerRemoval?.kind === 'runtime' && ownerRemoval.closeLegacyRuntimeTerminals === true
      ? ownerRemoval
      : null
  const workspaceKeys = new Set([...purgeKeys, ...ownerRemovalKeys])
  return [...workspaceKeys].map((workspaceKey) => {
    const tabs = state.tabsByWorktree[workspaceKey] ?? []
    const ptyIdsByTabId = new Map(
      tabs.map((tab) => [tab.id, collectFolderWorkspaceTerminalTabPtyIds(state, tab)])
    )
    const ptyIds = [...new Set([...ptyIdsByTabId.values()].flat())]
    const terminalHandles = runtimeCatalogRemoval
      ? getRuntimeTerminalHandlesFromPtyIds(ptyIds, runtimeCatalogRemoval.environmentId)
      : []
    const contentRemoval = snapshotFolderWorkspaceContentRemoval(state, workspaceKey, ownerRemoval)
    return {
      workspaceKey,
      ptyIds,
      purgeRendererState: purgeKeys.has(workspaceKey),
      ...contentRemoval,
      ownerRemoval: ownerRemoval && ownerRemovalKeys.has(workspaceKey) ? ownerRemoval : null,
      retireTabIds:
        ownerRemoval && ownerRemovalKeys.has(workspaceKey)
          ? tabs
              .filter((tab) =>
                folderWorkspaceTerminalTabBelongsToOwner(
                  state,
                  workspaceKey,
                  tab.id,
                  ownerRemoval,
                  ownerRemoval.hostId
                )
              )
              .map((tab) => tab.id)
          : [],
      runtimeCatalogRemoval:
        runtimeCatalogRemoval && ownerRemovalKeys.has(workspaceKey) && terminalHandles.length > 0
          ? {
              environmentId: runtimeCatalogRemoval.environmentId,
              expectedEnvironmentPairingRevision:
                runtimeCatalogRemoval.expectedEnvironmentPairingRevision,
              terminalHandles
            }
          : null
    }
  })
}

export async function teardownDeletedFolderWorkspaceRendererState(
  set: FolderWorkspaceRendererTeardownSet,
  get: () => AppState,
  snapshots: readonly FolderWorkspaceRendererTeardownSnapshot[],
  options: {
    isCurrent?: (snapshot: FolderWorkspaceRendererTeardownSnapshot) => boolean
  } = {}
): Promise<void> {
  if (snapshots.length === 0) {
    return
  }
  const isCurrent = options.isCurrent ?? (() => true)
  const backendTeardownByEnvironment = new Map<string, Promise<boolean>>()
  for (const snapshot of snapshots) {
    await closeLegacyRuntimeCatalogTerminals(
      snapshot.runtimeCatalogRemoval,
      backendTeardownByEnvironment,
      () => isCurrent(snapshot)
    )
  }
  for (const snapshot of snapshots) {
    if (snapshot.purgeRendererState || !isCurrent(snapshot)) {
      continue
    }
    teardownSelectiveFolderWorkspaceOwner({
      get,
      isCurrent: () => isCurrent(snapshot),
      ownerRemoval: snapshot.ownerRemoval,
      retireBrowserWorkspaceIds: snapshot.retireBrowserWorkspaceIds,
      retireEditorFileIds: snapshot.retireEditorFileIds,
      retireTabIds: snapshot.retireTabIds,
      retireUnifiedTabIds: snapshot.retireUnifiedTabIds,
      set,
      workspaceKey: snapshot.workspaceKey
    })
  }
  const purgeSnapshots = snapshots.filter((snapshot) => snapshot.purgeRendererState)
  for (const snapshot of purgeSnapshots) {
    const { workspaceKey, ptyIds } = snapshot
    if (!isCurrent(snapshot)) {
      continue
    }
    try {
      await get().shutdownWorktreeBrowsers(workspaceKey)
    } catch (error) {
      console.warn('Failed to shut down deleted folder workspace browsers:', error)
    }
    if (!isCurrent(snapshot)) {
      continue
    }
    try {
      await get().shutdownWorktreeTerminals(workspaceKey, {
        shutdownReason: 'remove-worktree',
        backendOwnsPtyTeardown: true,
        isCurrent: () => isCurrent(snapshot)
      })
    } catch (error) {
      // Why: backend deletion is authoritative, so renderer binding failure cannot retain the workspace.
      console.warn('Failed to retire deleted folder workspace terminals:', error)
    }
    if (!isCurrent(snapshot)) {
      continue
    }
    disposeRemovedWorktreeParkedTerminalWatchers(workspaceKey, ptyIds)
  }
  const currentPurgeKeys = purgeSnapshots
    .filter((snapshot) => isCurrent(snapshot))
    .map(({ workspaceKey }) => workspaceKey)
  if (currentPurgeKeys.length > 0) {
    get().purgeWorktreeTerminalState(currentPurgeKeys)
  }
}
