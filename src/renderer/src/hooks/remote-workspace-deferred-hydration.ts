import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import { importRemoteWorkspaceSession } from '../../../shared/remote-workspace-session-projection'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../../shared/types'
import { splitWorktreeId } from '../../../shared/worktree-id'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'
import { resolveDirectSshTargetScope } from '../lib/direct-ssh-target-scope'
import type { AppState } from '../store/types'
import { directSshAuthoritiesEqual } from './direct-ssh-reconnect-tokens'
import {
  mergeDirectSshRemoteWorkspaceSession,
  uniqueWorktreeIdByPath
} from './remote-workspace-session-merge'

export function exactTargetWorktreeIds(
  state: AppState,
  authority: DirectSshAuthority
): Set<string> {
  return resolveDirectSshTargetScope({
    targetId: authority.targetId,
    catalogRevision: 0,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }).gitWorktreeIds
}

export function currentRecoveryTabIds(
  state: AppState,
  authority: DirectSshAuthority,
  worktreeIds: ReadonlySet<string>
): Set<string> {
  const targetTabIds = new Set(
    [...worktreeIds].flatMap((worktreeId) =>
      (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
    )
  )
  return new Set(
    [
      ...Object.entries(state.directSshPaneRetryByTabId),
      ...Object.entries(state.directSshLivePtyBindingByTabId)
    ]
      .filter(
        ([tabId, entry]) =>
          targetTabIds.has(tabId) && directSshAuthoritiesEqual(entry.authority, authority)
      )
      .map(([tabId]) => tabId)
  )
}

export function deferredSnapshotTabPaths(
  state: AppState,
  authority: DirectSshAuthority,
  snapshot: RemoteWorkspaceSnapshot
): string[] {
  // Why: only paths absent from the catalog are worth waiting for; a path the catalog already knows but maps ambiguously (duplicate worktree paths) will never resolve by polling.
  const catalogPaths = new Set(
    [...exactTargetWorktreeIds(state, authority)]
      .map((worktreeId) => splitWorktreeId(worktreeId)?.worktreePath)
      .filter((path): path is string => Boolean(path))
  )
  return Object.entries(snapshot.session.tabsByWorktreePath ?? {})
    .filter(([worktreePath, tabs]) => (tabs ?? []).length > 0 && !catalogPaths.has(worktreePath))
    .map(([worktreePath]) => worktreePath)
}

export function classifyDepartedDeferredPaths(
  state: AppState,
  authority: DirectSshAuthority,
  departed: readonly string[]
): { resolved: string[]; unresolvable: string[] } {
  // Why: a path leaves the pending set either because it now resolves uniquely (hydrate it) or because the catalog gained it ambiguously (report it) — treating the latter as resolved would end the watch on a false synced status.
  const resolve = uniqueWorktreeIdByPath(exactTargetWorktreeIds(state, authority))
  const resolved: string[] = []
  const unresolvable: string[] = []
  for (const worktreePath of departed) {
    ;(resolve(worktreePath) ? resolved : unresolvable).push(worktreePath)
  }
  return { resolved, unresolvable }
}

export function buildDeferredWorktreeMerge(
  state: AppState,
  authority: DirectSshAuthority,
  snapshot: RemoteWorkspaceSnapshot,
  resolvedPaths: readonly string[]
): { lateScope: Set<string>; lateMerged: WorkspaceSessionState } {
  // Why: the resolver must cover only this tick's newly-resolved paths — a broader one would leak already-hydrated worktrees into the import, and the merge would reset them to stale snapshot state.
  const resolvedPathSet = new Set(resolvedPaths)
  const catalogResolve = uniqueWorktreeIdByPath(exactTargetWorktreeIds(state, authority))
  const resolveWorktreeId = (worktreePath: string): string | null =>
    resolvedPathSet.has(worktreePath) ? catalogResolve(worktreePath) : null
  const lateScope = new Set(
    resolvedPaths
      .map((worktreePath) => resolveWorktreeId(worktreePath))
      .filter((id): id is string => Boolean(id))
  )
  const lateRemote = importRemoteWorkspaceSession(snapshot.session, { resolveWorktreeId })
  const lateCurrent = buildWorkspaceSessionPayload(state)
  // Why: the merge replaces a worktree's tab list from the remote side; union live-only tabs in (marked preserved) so this late pass is purely additive and never removes a live tab, layout, or pty binding.
  const lateExtraTabIds = new Set<string>()
  for (const worktreeId of lateScope) {
    const liveTabs = state.tabsByWorktree[worktreeId] ?? []
    const remoteTabs = lateRemote.tabsByWorktree[worktreeId] ?? []
    const remoteTabIds = new Set(remoteTabs.map((tab) => tab.id))
    const extraLocal = liveTabs.filter((tab) => !remoteTabIds.has(tab.id))
    if (extraLocal.length === 0) {
      continue
    }
    lateRemote.tabsByWorktree[worktreeId] = [...remoteTabs, ...extraLocal]
    for (const tab of extraLocal) {
      lateExtraTabIds.add(tab.id)
    }
  }
  const latePreserve = currentRecoveryTabIds(state, authority, lateScope)
  for (const tabId of lateExtraTabIds) {
    latePreserve.add(tabId)
  }
  const lateMerged = mergeDirectSshRemoteWorkspaceSession(
    lateCurrent,
    lateRemote,
    lateScope,
    state.tabsByWorktree,
    latePreserve
  )
  // Why: a background catch-up hydrate must never move the user's focus; the merge otherwise adopts the snapshot's recorded active worktree/tab (or null).
  lateMerged.activeRepoId = lateCurrent.activeRepoId
  lateMerged.activeWorktreeId = lateCurrent.activeWorktreeId
  lateMerged.activeWorkspaceKey = lateCurrent.activeWorkspaceKey
  lateMerged.activeTabId = lateCurrent.activeTabId
  return { lateScope, lateMerged }
}
