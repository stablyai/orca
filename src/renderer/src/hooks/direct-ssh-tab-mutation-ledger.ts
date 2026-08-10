import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import { resolveDirectSshTargetScope } from '../lib/direct-ssh-target-scope'
import type { AppState } from '../store/types'

export type PendingTabPresence = 'present' | 'absent'

export type DirectSshTabMutationReconciliation = {
  acknowledgeSnapshot: (targetId: string, snapshot: RemoteWorkspaceSnapshot) => void
  beginSnapshotApply: (targetId: string) => () => void
  canApplySnapshot?: (targetId: string) => boolean
  pendingTabPresence: (targetId: string) => ReadonlyMap<string, PendingTabPresence>
}

export type DirectSshTabMutationLedger = DirectSshTabMutationReconciliation & {
  clear: () => void
  observeState: (state: AppState) => void
}

type TargetLedger = {
  observedTabIds: Set<string>
  pendingTabPresence: Map<string, PendingTabPresence>
  worktreeIds: Set<string>
  requiresLocalPush: boolean
}

type ScopeInputRefs = Pick<
  AppState,
  | 'sshTargetLabels'
  | 'sshConnectionStates'
  | 'remoteWorkspaceHydratedTargetIds'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

const MAX_PENDING_TAB_MUTATIONS_PER_TARGET = 2_048

function configuredTargetIds(state: AppState): Set<string> {
  return new Set([
    ...state.sshTargetLabels.keys(),
    ...state.sshConnectionStates.keys(),
    ...state.remoteWorkspaceHydratedTargetIds
  ])
}

function targetWorktreeIds(state: AppState, targetId: string): Set<string> {
  return resolveDirectSshTargetScope({
    targetId,
    catalogRevision: 0,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }).gitWorktreeIds
}

function targetTabIds(state: AppState, worktreeIds: ReadonlySet<string>): Set<string> {
  return new Set(
    [...worktreeIds].flatMap((worktreeId) =>
      (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
    )
  )
}

function remoteTabIds(snapshot: RemoteWorkspaceSnapshot): Set<string> {
  return new Set(
    Object.values(snapshot.session.tabsByWorktreePath).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function recordPresence(entry: TargetLedger, tabId: string, presence: PendingTabPresence): void {
  if (entry.requiresLocalPush) {
    return
  }
  entry.pendingTabPresence.set(tabId, presence)
  if (entry.pendingTabPresence.size > MAX_PENDING_TAB_MUTATIONS_PER_TARGET) {
    entry.pendingTabPresence.clear()
    entry.requiresLocalPush = true
  }
}

function scopeInputRefs(state: AppState): ScopeInputRefs {
  return {
    sshTargetLabels: state.sshTargetLabels,
    sshConnectionStates: state.sshConnectionStates,
    remoteWorkspaceHydratedTargetIds: state.remoteWorkspaceHydratedTargetIds,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }
}

function scopeInputsEqual(previous: ScopeInputRefs | null, next: ScopeInputRefs): boolean {
  return (
    previous !== null &&
    Object.keys(next).every(
      (key) => previous[key as keyof ScopeInputRefs] === next[key as keyof ScopeInputRefs]
    )
  )
}

export function createDirectSshTabMutationLedger(): DirectSshTabMutationLedger {
  const targetLedgers = new Map<string, TargetLedger>()
  const snapshotApplyDepthByTarget = new Map<string, number>()
  let cachedScopeByTarget = new Map<string, Set<string>>()
  let previousScopeInputs: ScopeInputRefs | null = null
  let previousTabsByWorktree: AppState['tabsByWorktree'] | null = null

  const observeState = (state: AppState): void => {
    const nextScopeInputs = scopeInputRefs(state)
    const scopeChanged = !scopeInputsEqual(previousScopeInputs, nextScopeInputs)
    if (!scopeChanged && previousTabsByWorktree === state.tabsByWorktree) {
      return
    }
    previousScopeInputs = nextScopeInputs
    previousTabsByWorktree = state.tabsByWorktree
    if (scopeChanged) {
      const targetIds = configuredTargetIds(state)
      for (const targetId of targetLedgers.keys()) {
        if (!targetIds.has(targetId)) {
          targetLedgers.delete(targetId)
          snapshotApplyDepthByTarget.delete(targetId)
        }
      }
      const ownersByWorktree = new Map<string, string[]>()
      const rawScopeByTarget = new Map<string, Set<string>>()
      for (const targetId of targetIds) {
        const worktreeIds = targetWorktreeIds(state, targetId)
        rawScopeByTarget.set(targetId, worktreeIds)
        for (const worktreeId of worktreeIds) {
          ownersByWorktree.set(worktreeId, [...(ownersByWorktree.get(worktreeId) ?? []), targetId])
        }
      }
      cachedScopeByTarget = new Map(
        [...rawScopeByTarget].map(([targetId, worktreeIds]) => [
          targetId,
          new Set(
            [...worktreeIds].filter((worktreeId) => ownersByWorktree.get(worktreeId)?.length === 1)
          )
        ])
      )
    }
    for (const [targetId, worktreeIds] of cachedScopeByTarget) {
      const tabIds = targetTabIds(state, worktreeIds)
      const existing = targetLedgers.get(targetId)
      if (!existing) {
        targetLedgers.set(targetId, {
          observedTabIds: tabIds,
          pendingTabPresence: new Map(),
          worktreeIds,
          requiresLocalPush: false
        })
        continue
      }
      if (!setsEqual(existing.worktreeIds, worktreeIds)) {
        existing.requiresLocalPush ||= existing.pendingTabPresence.size > 0
        existing.pendingTabPresence.clear()
        existing.observedTabIds = tabIds
        existing.worktreeIds = worktreeIds
        continue
      }
      if ((snapshotApplyDepthByTarget.get(targetId) ?? 0) === 0) {
        for (const tabId of tabIds) {
          if (!existing.observedTabIds.has(tabId)) {
            recordPresence(existing, tabId, 'present')
          }
        }
        for (const tabId of existing.observedTabIds) {
          if (!tabIds.has(tabId)) {
            recordPresence(existing, tabId, 'absent')
          }
        }
      }
      existing.observedTabIds = tabIds
      existing.worktreeIds = worktreeIds
    }
  }

  return {
    observeState,
    acknowledgeSnapshot: (targetId, snapshot) => {
      const entry = targetLedgers.get(targetId)
      if (!entry) {
        return
      }
      const acknowledgedTabIds = remoteTabIds(snapshot)
      if (entry.requiresLocalPush) {
        if (setsEqual(acknowledgedTabIds, entry.observedTabIds)) {
          entry.requiresLocalPush = false
        }
        return
      }
      for (const [tabId, presence] of entry.pendingTabPresence) {
        if (acknowledgedTabIds.has(tabId) === (presence === 'present')) {
          entry.pendingTabPresence.delete(tabId)
        }
      }
    },
    beginSnapshotApply: (targetId) => {
      snapshotApplyDepthByTarget.set(targetId, (snapshotApplyDepthByTarget.get(targetId) ?? 0) + 1)
      let ended = false
      return () => {
        if (ended) {
          return
        }
        ended = true
        const depth = (snapshotApplyDepthByTarget.get(targetId) ?? 1) - 1
        if (depth === 0) {
          snapshotApplyDepthByTarget.delete(targetId)
        } else {
          snapshotApplyDepthByTarget.set(targetId, depth)
        }
      }
    },
    canApplySnapshot: (targetId) => !targetLedgers.get(targetId)?.requiresLocalPush,
    pendingTabPresence: (targetId) => targetLedgers.get(targetId)?.pendingTabPresence ?? new Map(),
    clear: () => {
      targetLedgers.clear()
      snapshotApplyDepthByTarget.clear()
      cachedScopeByTarget.clear()
      previousScopeInputs = null
      previousTabsByWorktree = null
    }
  }
}
