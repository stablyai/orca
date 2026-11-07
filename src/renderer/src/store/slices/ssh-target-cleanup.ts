import type { AppState } from '../types'
import type { SshTarget, SshTargetSummary } from '../../../../shared/ssh-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { sanitizeSshTargetGeneration } from '../../../../shared/ssh-target-generation'
import { resolveDirectSshTargetWorktreeIds } from '../../lib/direct-ssh-target-scope'
import { unbindTerminalTabPtys } from './tabs/worktree-layout-lifecycle'
import { selectDetectedWorktreesByRepo, selectWorktreesByRepo } from '../workspace-record-selectors'

export function sshTargetLabelsEqual(
  labels: Map<string, string>,
  targets: Pick<SshTarget, 'id' | 'label'>[]
): boolean {
  if (labels.size !== targets.length) {
    return false
  }
  return targets.every((target) => labels.get(target.id) === target.label)
}

/** Keep only sanitized registration generations; never guess absent values, which would fence against a nonexistent registration. */
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
  const targetWorktreeIds = resolveDirectSshTargetWorktreeIds({
    targetId,
    repos: state.repos,
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  })
  const tabIds = new Set<string>()
  for (const worktrees of Object.values(selectWorktreesByRepo(state))) {
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

// Match removed target by tab ownership or SSH PTY ID; reconnect maps count as liveness and must not pin dead tabs (#9911).
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

function clearSshTargetTabPtyState(
  state: AppState,
  targetId: string,
  targetTabIds: Set<string>
): Pick<
  AppState,
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'lastKnownRelayPtyIdByTabId'
  | 'pendingPaneAccountRestarts'
  | 'codexRestartNoticeByPtyId'
> & { changed: boolean } {
  const unboundTabIds = new Set<string>()
  const nextLastKnownRelayPtyIdByTabId = {
    ...state.lastKnownRelayPtyIdByTabId
  }
  const nextPendingPaneAccountRestarts = {
    ...state.pendingPaneAccountRestarts
  }
  const nextCodexRestartNoticeByPtyId = { ...state.codexRestartNoticeByPtyId }

  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
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
      unboundTabIds.add(tab.id)
      delete nextLastKnownRelayPtyIdByTabId[tab.id]
      for (const ptyId of ptyIds) {
        delete nextPendingPaneAccountRestarts[ptyId]
        delete nextCodexRestartNoticeByPtyId[ptyId]
      }
    }
  }

  return {
    changed: unboundTabIds.size > 0,
    ...unbindTerminalTabPtys(state, unboundTabIds),
    lastKnownRelayPtyIdByTabId: nextLastKnownRelayPtyIdByTabId,
    pendingPaneAccountRestarts: nextPendingPaneAccountRestarts,
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
  // Reconnect maps count as orphan-sweep liveness; removed targets must not leave dead tabs pinned (#9911).
  assign(
    'pendingReconnectPtyIdByTabId',
    omitRemovedSshTargetTabSessions(state.pendingReconnectPtyIdByTabId, targetId, targetTabIds)
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
  assign('portForwardsByConnection', omitKey(state.portForwardsByConnection, targetId))
  assign(
    'unrestoredPortForwardsByConnection',
    omitKey(state.unrestoredPortForwardsByConnection, targetId)
  )
  assign('detectedPortsByConnection', omitKey(state.detectedPortsByConnection, targetId))
  assign('sshConnectionStates', withoutMapKey(state.sshConnectionStates, targetId))
  assign('sshTargetLabels', withoutMapKey(state.sshTargetLabels, targetId))
  // Deleted registration generations cannot become valid again; re-add issues a fresh ID.
  assign('sshTargetGenerations', withoutMapKey(state.sshTargetGenerations, targetId))
  return Object.keys(patch).length > 0 ? patch : null
}
