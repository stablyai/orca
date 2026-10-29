import { editSessionSource, type SessionSourceEdit } from '@/store/session-source-edits'
import { runAsAutomaticDeselection } from '@/store/active-worktree-deselection-intent'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { AppState } from '../../../types'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getWorktreeIdFromVisitKey,
  getWorktreeVisitKey,
  getWorktreeVisitTimestamp
} from '@/lib/worktree-visit-recency'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '../../../workspace-record-selectors'

export function createMarkWorktreeVisited(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['markWorktreeVisited'] {
  return (worktreeId, visitedAt, executionHostId) => {
    set((s) => {
      const edit = editSessionSource(s)
      stampWorktreeVisit(edit, worktreeId, visitedAt, executionHostId)
      return edit.changed ? edit.finish() : undefined
    })
  }
}

/** Extends the accepted edit only when this focus timestamp advances. */
export function stampWorktreeVisit(
  edit: SessionSourceEdit<AppState>,
  worktreeId: string,
  visitedAt?: number,
  executionHostId?: ExecutionHostId,
  selection?: Pick<AppState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>
): void {
  const s = edit.view(selection)
  // Cmd+J needs user-focus recency independent of PTY activity; racing CLI/IPC timestamps must not regress (cmd-j-empty-query-ordering.md).
  const now = visitedAt ?? Date.now()
  const ownerHostId =
    executionHostId ??
    (s.activeWorktreeId === worktreeId ? s.activeWorkspaceExecutionHostId : undefined) ??
    s.getKnownWorktreeById(worktreeId, executionHostId)?.hostId
  const prev =
    getWorktreeVisitTimestamp(s.lastVisitedAtByWorktreeId, {
      id: worktreeId,
      hostId: ownerHostId
    }) ?? 0
  if (!(now > prev)) {
    return
  }
  edit.set('lastVisitedAtByWorktreeId', getWorktreeVisitKey(worktreeId, ownerHostId), now)
}

export function createPruneLastVisitedTimestamps(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['pruneLastVisitedTimestamps'] {
  const prune = () => {
    set((s) => {
      // Prune only hydrated repo entries; global pruning would erase disconnected SSH recency before its rows load.
      const validIdsByRepo = new Map<string, Set<string>>()
      const validWorktreeIds = new Set<string>()
      const validVisitKeys = new Set<string>()
      const addValidWorktree = (worktree: { id: string; hostId?: ExecutionHostId }): void => {
        validWorktreeIds.add(worktree.id)
        validVisitKeys.add(getWorktreeVisitKey(worktree.id, worktree.hostId))
      }
      for (const [repoId, list] of Object.entries(selectWorktreesByRepo(s))) {
        // An empty list is the not-yet-hydrated shape, not an authoritative "no worktrees".
        if (selectDetectedWorktreesByRepo(s)[repoId] || list.length === 0) {
          continue
        }
        validIdsByRepo.set(repoId, new Set(list.map((worktree) => worktree.id)))
        list.forEach(addValidWorktree)
      }
      for (const [repoId, result] of Object.entries(selectDetectedWorktreesByRepo(s))) {
        if (result.authoritative) {
          validIdsByRepo.set(repoId, new Set(result.worktrees.map((worktree) => worktree.id)))
          result.worktrees.forEach(addValidWorktree)
        }
      }
      const edit = editSessionSource(s)
      for (const key of Object.keys(s.lastVisitedAtByWorktreeId)) {
        const id = getWorktreeIdFromVisitKey(key)
        const repoId = getRepoIdFromWorktreeId(id)
        const repoIds = validIdsByRepo.get(repoId)
        if (!repoIds) {
          // Repo not yet hydrated (e.g. SSH not connected). Keep the entry.
          continue
        }
        // Legacy bare keys remain valid when any host still publishes the id;
        // qualified keys must match the exact host-qualified row.
        if (!(getWorktreeIdFromVisitKey(key) === key ? repoIds.has(id) : validVisitKeys.has(key))) {
          edit.remove('lastVisitedAtByWorktreeId', key)
        }
      }
      const patch: {
        activeWorktreeId?: null
        activeWorkspaceKey?: null
        activeWorkspaceExecutionHostId?: null
      } = {}
      // Web localStorage lacks main’s stale-pointer GC; clear active worktrees only after their repo proves them gone or phantom workspaces survive.
      const activeId = s.activeWorktreeId
      if (activeId) {
        const activeRepoWorktreeIds = validIdsByRepo.get(getRepoIdFromWorktreeId(activeId))
        if (activeRepoWorktreeIds && !activeRepoWorktreeIds.has(activeId)) {
          patch.activeWorktreeId = null
          // Clear only this stale worktree’s derived/legacy key; folder and other live keys must survive.
          if (
            s.activeWorkspaceKey === worktreeWorkspaceKey(activeId) ||
            s.activeWorkspaceKey === activeId
          ) {
            patch.activeWorkspaceKey = null
          }
          patch.activeWorkspaceExecutionHostId = null
        }
      }
      return edit.changed || Object.keys(patch).length > 0 ? edit.finish(patch) : undefined
    })
  }
  return () => runAsAutomaticDeselection(prune)
}

export function createSeedActiveWorktreeLastVisitedIfMissing(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['seedActiveWorktreeLastVisitedIfMissing'] {
  return () => {
    set((s) => {
      const id = s.activeWorktreeId
      if (!id) {
        return undefined
      }
      const hostId = s.activeWorkspaceExecutionHostId ?? s.getKnownWorktreeById(id)?.hostId
      const key = getWorktreeVisitKey(id, hostId)
      if (getWorktreeVisitTimestamp(s.lastVisitedAtByWorktreeId, { id, hostId }) != null) {
        return undefined
      }
      return editSessionSource(s).set('lastVisitedAtByWorktreeId', key, Date.now()).finish({})
    })
  }
}
