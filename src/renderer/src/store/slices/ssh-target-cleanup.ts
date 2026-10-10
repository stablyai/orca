import type { AppState } from '../types'
import type { SshTarget, SshTargetSummary } from '../../../../shared/ssh-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { sanitizeSshTargetGeneration } from '../../../../shared/ssh-target-generation'
import { resolveDirectSshTargetScope } from '../../lib/direct-ssh-target-scope'

export function sshTargetLabelsEqual(
  labels: Map<string, string>,
  targets: Pick<SshTarget, 'id' | 'label'>[]
): boolean {
  if (labels.size !== targets.length) {
    return false
  }
  return targets.every((target) => labels.get(target.id) === target.label)
}

/**
 * Registration generations by target ID, dropping any the sanitizer rejects.
 *
 * An absent generation is left absent rather than defaulted: only a generation
 * makes a target fenceable, and a guessed one would fence an automation against
 * a registration that never existed.
 */
export function collectSshTargetGenerations(targets: SshTargetSummary[]): Map<string, number> {
  const generations = new Map<string, number>()
  for (const target of targets) {
    const generation = sanitizeSshTargetGeneration(target.generation)
    if (generation !== undefined) {
      generations.set(target.id, generation)
    }
  }
  return generations
}

export function sshTargetGenerationsEqual(
  current: Map<string, number>,
  next: Map<string, number>
): boolean {
  return (
    current.size === next.size &&
    [...next].every(([targetId, generation]) => current.get(targetId) === generation)
  )
}

function collectSshTargetTerminalTabIds(state: AppState, targetId: string): Set<string> {
  const targetWorktreeIds = resolveDirectSshTargetScope({
    targetId,
    catalogRevision: 0,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }).gitWorktreeIds
  const tabIds = new Set<string>()
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (!targetWorktreeIds.has(worktree.id)) {
        continue
      }
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

// Why: a per-tab session map entry belongs to the removed target if the tab is
// one of the target's, or the session id is an SSH pty id scoped to it. Shared
// by the deferred-session and pending-reconnect cleanups so both drop the same
// dead entries (an uncleared entry would keep a dead tab alive in the orphan
// sweep, which now reads these maps as liveness — #9911).
function isRemovedSshTargetTabSession(
  tabId: string,
  sessionId: string,
  targetId: string,
  targetTabIds: Set<string>
): boolean {
  return targetTabIds.has(tabId) || isSshTargetSessionId(sessionId, targetId)
}

// Why: each returns undefined when nothing was removed, so the patch only carries changed fields.
function filterRecordIfChanged<T>(
  record: Record<string, T>,
  keep: (key: string, value: T) => boolean
): Record<string, T> | undefined {
  const entries = Object.entries(record)
  const kept = entries.filter(([key, value]) => keep(key, value))
  return kept.length === entries.length ? undefined : Object.fromEntries(kept)
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined
  }
  const { [key]: _removed, ...next } = record
  return next
}

function withoutMapKey<V>(map: Map<string, V>, key: string): Map<string, V> | undefined {
  const next = new Map(map)
  return next.delete(key) ? next : undefined
}

function withoutSetKey(set: Set<string>, key: string): Set<string> | undefined {
  const next = new Set(set)
  return next.delete(key) ? next : undefined
}

function filterIfChanged<T>(items: T[], keep: (item: T) => boolean): T[] | undefined {
  const next = items.filter(keep)
  return next.length === items.length ? undefined : next
}

function omitRemovedSshTargetTabSessions(
  sessions: Record<string, string>,
  targetId: string,
  targetTabIds: Set<string>
): Record<string, string> | undefined {
  return filterRecordIfChanged(
    sessions,
    (tabId, sessionId) => !isRemovedSshTargetTabSession(tabId, sessionId, targetId, targetTabIds)
  )
}

function omitRemovedSshTargetRecovery<T extends { authority: { targetId: string } }>(
  entries: Record<string, T>,
  targetId: string,
  targetTabIds: ReadonlySet<string>
): Record<string, T> | undefined {
  return filterRecordIfChanged(
    entries,
    (tabId, entry) => !targetTabIds.has(tabId) && entry.authority.targetId !== targetId
  )
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
  const nextLastKnownRelayPtyIdByTabId = {
    ...state.lastKnownRelayPtyIdByTabId
  }
  const nextPendingCodexPaneRestartIds = {
    ...state.pendingCodexPaneRestartIds
  }
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
      if (nextTabsByWorktree === state.tabsByWorktree) {
        nextTabsByWorktree = { ...nextTabsByWorktree }
      }
      nextTabsByWorktree[worktreeId] = nextTabs
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
  const { changed: tabPtyChanged, ...tabPtyPatch } = clearSshTargetTabPtyState(
    state,
    targetId,
    targetTabIds
  )
  const patch: Partial<AppState> = tabPtyChanged ? tabPtyPatch : {}
  const assign = <K extends keyof AppState>(key: K, value: AppState[K] | undefined): void => {
    if (value !== undefined) {
      patch[key] = value
    }
  }
  assign(
    'deferredSshSessionIdsByTabId',
    omitRemovedSshTargetTabSessions(state.deferredSshSessionIdsByTabId, targetId, targetTabIds)
  )
  // Why: pending-reconnect holds each tab's pre-restart session until reconnect
  // drains it; if the target is removed first the entry is dead but the orphan
  // sweep now reads it as liveness, so clear it here too (#9911).
  assign(
    'pendingReconnectPtyIdByTabId',
    omitRemovedSshTargetTabSessions(state.pendingReconnectPtyIdByTabId, targetId, targetTabIds)
  )
  assign(
    'directSshPaneRetryByTabId',
    omitRemovedSshTargetRecovery(state.directSshPaneRetryByTabId, targetId, targetTabIds)
  )
  assign(
    'directSshLivePtyBindingByTabId',
    omitRemovedSshTargetRecovery(state.directSshLivePtyBindingByTabId, targetId, targetTabIds)
  )
  assign(
    'directSshPaneRetryHistoryByTabId',
    omitRemovedSshTargetRecovery(state.directSshPaneRetryHistoryByTabId, targetId, targetTabIds)
  )
  assign(
    'pendingDirectSshLayoutEditsByTabId',
    filterRecordIfChanged(
      state.pendingDirectSshLayoutEditsByTabId ?? {},
      (_tabId, entry) => entry.targetId !== targetId
    )
  )
  assign(
    'deferredSshReconnectTargets',
    filterIfChanged(state.deferredSshReconnectTargets, (id) => id !== targetId)
  )
  assign(
    'sshCredentialQueue',
    filterIfChanged(state.sshCredentialQueue, (req) => req.targetId !== targetId)
  )
  assign(
    'transientClearedAgentStatusConnectionIds',
    omitKey(state.transientClearedAgentStatusConnectionIds, targetId)
  )
  assign(
    'remoteWorkspaceSyncStatusByTargetId',
    omitKey(state.remoteWorkspaceSyncStatusByTargetId, targetId)
  )
  assign('portForwardsByConnection', omitKey(state.portForwardsByConnection, targetId))
  assign('detectedPortsByConnection', omitKey(state.detectedPortsByConnection, targetId))
  assign('sshConnectionStates', withoutMapKey(state.sshConnectionStates, targetId))
  assign('sshTargetLabels', withoutMapKey(state.sshTargetLabels, targetId))
  // Why: a lingering generation would keep a deleted registration fenceable, and
  // the id is reissued fresh on re-add, so the old value can never become right.
  assign('sshTargetGenerations', withoutMapKey(state.sshTargetGenerations, targetId))
  assign(
    'remoteWorkspaceHydratedTargetIds',
    withoutSetKey(state.remoteWorkspaceHydratedTargetIds, targetId)
  )
  return Object.keys(patch).length > 0 ? patch : null
}
