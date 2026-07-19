import type { AppState } from '../types'
import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'

export function sshConnectionStatesEqual(
  a: SshConnectionState | undefined,
  b: SshConnectionState
): boolean {
  return (
    a?.targetId === b.targetId &&
    a?.status === b.status &&
    a?.error === b.error &&
    a?.reconnectAttempt === b.reconnectAttempt &&
    a?.supportsFolderDownload === b.supportsFolderDownload &&
    a?.remotePlatform === b.remotePlatform
  )
}

export function sshTargetLabelsEqual(
  labels: Map<string, string>,
  targets: Pick<SshTarget, 'id' | 'label'>[]
): boolean {
  if (labels.size !== targets.length) {
    return false
  }
  return targets.every((target) => labels.get(target.id) === target.label)
}

function collectSshTargetTerminalTabIds(state: AppState, targetId: string): Set<string> {
  const repoIds = new Set(
    state.repos.filter((repo) => repo.connectionId === targetId).map((repo) => repo.id)
  )
  const tabIds = new Set<string>()
  for (const [repoId, worktrees] of Object.entries(state.worktreesByRepo)) {
    if (!repoIds.has(repoId)) {
      continue
    }
    for (const worktree of worktrees) {
      for (const tab of state.tabsByWorktree[worktree.id] ?? []) {
        tabIds.add(tab.id)
      }
    }
  }
  return tabIds
}

function isSshTargetSessionId(sessionId: string, targetId: string): boolean {
  return parseAppSshPtyId(sessionId)?.connectionId === targetId
}

function shouldRemoveDeferredSshSession(
  tabId: string,
  sessionId: string,
  targetId: string,
  targetTabIds: Set<string>
): boolean {
  return targetTabIds.has(tabId) || isSshTargetSessionId(sessionId, targetId)
}

function clearSshTargetTabPtyState(
  state: AppState,
  targetId: string,
  targetTabIds: Set<string>
): Pick<
  AppState,
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'lastKnownRelayPtyIdByTabId'
  | 'pendingCodexPaneRestartIds'
  | 'codexRestartNoticeByPtyId'
> & { changed: boolean } {
  let nextTabsByWorktree = state.tabsByWorktree
  const nextPtyIdsByTabId = { ...state.ptyIdsByTabId }
  const nextLastKnownRelayPtyIdByTabId = { ...state.lastKnownRelayPtyIdByTabId }
  const nextPendingCodexPaneRestartIds = { ...state.pendingCodexPaneRestartIds }
  const nextCodexRestartNoticeByPtyId = { ...state.codexRestartNoticeByPtyId }
  let changed = false

  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    let nextTabs = tabs
    for (const [index, tab] of tabs.entries()) {
      const lastKnownPtyId = state.lastKnownRelayPtyIdByTabId[tab.id]
      const ptyIds = [
        ...new Set([
          ...(state.ptyIdsByTabId[tab.id] ?? []),
          ...(tab.ptyId ? [tab.ptyId] : []),
          ...(lastKnownPtyId ? [lastKnownPtyId] : [])
        ])
      ]
      const shouldClearTab =
        targetTabIds.has(tab.id) || ptyIds.some((ptyId) => isSshTargetSessionId(ptyId, targetId))
      if (!shouldClearTab) {
        continue
      }
      if (!tab.ptyId && ptyIds.length === 0 && nextLastKnownRelayPtyIdByTabId[tab.id] == null) {
        continue
      }
      changed = true
      if (nextTabs === tabs) {
        nextTabs = [...tabs]
      }
      const { pendingActivationSpawn: _pendingActivationSpawn, ...tabWithoutActivationSpawn } = tab
      void _pendingActivationSpawn
      nextTabs[index] = { ...tabWithoutActivationSpawn, ptyId: null }
      nextPtyIdsByTabId[tab.id] = []
      delete nextLastKnownRelayPtyIdByTabId[tab.id]
      for (const ptyId of ptyIds) {
        delete nextPendingCodexPaneRestartIds[ptyId]
        delete nextCodexRestartNoticeByPtyId[ptyId]
      }
    }
    if (nextTabs !== tabs) {
      nextTabsByWorktree = { ...nextTabsByWorktree, [worktreeId]: nextTabs }
    }
  }

  return {
    changed,
    tabsByWorktree: nextTabsByWorktree,
    ptyIdsByTabId: nextPtyIdsByTabId,
    lastKnownRelayPtyIdByTabId: nextLastKnownRelayPtyIdByTabId,
    pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds,
    codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId
  }
}

export function buildRemovedSshTargetCleanupPatch(
  state: AppState,
  targetId: string
): Partial<AppState> | null {
  const targetTabIds = collectSshTargetTerminalTabIds(state, targetId)
  const tabPtyState = clearSshTargetTabPtyState(state, targetId, targetTabIds)
  const nextDeferredSessions: Record<string, string> = {}
  let removedDeferredSession = false
  for (const [tabId, sessionId] of Object.entries(state.deferredSshSessionIdsByTabId)) {
    if (shouldRemoveDeferredSshSession(tabId, sessionId, targetId, targetTabIds)) {
      removedDeferredSession = true
      continue
    }
    nextDeferredSessions[tabId] = sessionId
  }

  const nextDeferredTargets = state.deferredSshReconnectTargets.filter((id) => id !== targetId)
  const nextConnectionStates = new Map(state.sshConnectionStates)
  const removedConnectionState = nextConnectionStates.delete(targetId)
  const nextLabels = new Map(state.sshTargetLabels)
  const removedLabel = nextLabels.delete(targetId)
  const nextHydrated = new Set(state.remoteWorkspaceHydratedTargetIds)
  const removedHydrated = nextHydrated.delete(targetId)
  const removedSyncStatus = Object.prototype.hasOwnProperty.call(
    state.remoteWorkspaceSyncStatusByTargetId,
    targetId
  )
  const removedPortForwards = Object.prototype.hasOwnProperty.call(
    state.portForwardsByConnection,
    targetId
  )
  const removedDetectedPorts = Object.prototype.hasOwnProperty.call(
    state.detectedPortsByConnection,
    targetId
  )
  const nextSyncStatus = { ...state.remoteWorkspaceSyncStatusByTargetId }
  delete nextSyncStatus[targetId]
  const nextPortForwards = { ...state.portForwardsByConnection }
  delete nextPortForwards[targetId]
  const nextDetectedPorts = { ...state.detectedPortsByConnection }
  delete nextDetectedPorts[targetId]
  const nextCredentialQueue = state.sshCredentialQueue.filter((req) => req.targetId !== targetId)
  const removedCredentialRequest = nextCredentialQueue.length !== state.sshCredentialQueue.length
  const removedDeferredTarget =
    nextDeferredTargets.length !== state.deferredSshReconnectTargets.length
  const changed =
    removedConnectionState ||
    removedLabel ||
    removedHydrated ||
    removedSyncStatus ||
    removedPortForwards ||
    removedDetectedPorts ||
    tabPtyState.changed ||
    removedCredentialRequest ||
    removedDeferredTarget ||
    removedDeferredSession
  if (!changed) {
    return null
  }

  return {
    ...(removedConnectionState ? { sshConnectionStates: nextConnectionStates } : {}),
    ...(removedLabel ? { sshTargetLabels: nextLabels } : {}),
    ...(removedHydrated ? { remoteWorkspaceHydratedTargetIds: nextHydrated } : {}),
    ...(removedSyncStatus ? { remoteWorkspaceSyncStatusByTargetId: nextSyncStatus } : {}),
    ...(removedPortForwards ? { portForwardsByConnection: nextPortForwards } : {}),
    ...(removedDetectedPorts ? { detectedPortsByConnection: nextDetectedPorts } : {}),
    ...(tabPtyState.changed
      ? {
          tabsByWorktree: tabPtyState.tabsByWorktree,
          ptyIdsByTabId: tabPtyState.ptyIdsByTabId,
          lastKnownRelayPtyIdByTabId: tabPtyState.lastKnownRelayPtyIdByTabId,
          pendingCodexPaneRestartIds: tabPtyState.pendingCodexPaneRestartIds,
          codexRestartNoticeByPtyId: tabPtyState.codexRestartNoticeByPtyId
        }
      : {}),
    ...(removedCredentialRequest ? { sshCredentialQueue: nextCredentialQueue } : {}),
    ...(removedDeferredTarget ? { deferredSshReconnectTargets: nextDeferredTargets } : {}),
    ...(removedDeferredSession ? { deferredSshSessionIdsByTabId: nextDeferredSessions } : {})
  }
}
