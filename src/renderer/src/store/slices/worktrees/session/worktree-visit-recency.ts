import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getWorktreeIdFromVisitKey,
  getWorktreeVisitKey,
  getWorktreeVisitTimestamp
} from '@/lib/worktree-visit-recency'

export function createMarkWorktreeVisited(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['markWorktreeVisited'] {
  return (worktreeId, visitedAt, executionHostId) => {
    // Why: Cmd+J empty-query ordering needs a focus-recency signal distinct from lastActivityAt (background PTY/activity).
    // Monotonic: CLI/IPC activations can race, so older timestamps must not regress. See docs/cmd-j-empty-query-ordering.md.
    set((s) => {
      const now = visitedAt ?? Date.now()
      const ownerHostId =
        executionHostId ??
        (s.activeWorktreeId === worktreeId ? s.activeWorkspaceExecutionHostId : undefined) ??
        s.getKnownWorktreeById(worktreeId, executionHostId)?.hostId
      const visitKey = getWorktreeVisitKey(worktreeId, ownerHostId)
      const prev =
        getWorktreeVisitTimestamp(s.lastVisitedAtByWorktreeId, {
          id: worktreeId,
          hostId: ownerHostId
        }) ?? 0
      if (!(now > prev)) {
        return {}
      }
      return {
        lastVisitedAtByWorktreeId: {
          ...s.lastVisitedAtByWorktreeId,
          [visitKey]: now
        }
      }
    })
  }
}

export function createPruneLastVisitedTimestamps(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['pruneLastVisitedTimestamps'] {
  return () => {
    set((s) => {
      // Why: prune per-repo, not globally — SSH repos aren't hydrated at startup, so a global prune would wipe SSH focus-recency.
      // Only drop for repos with a populated/authoritative list; a missing repoId means not-yet-hydrated (defer).
      const validIdsByRepo = new Map<string, Set<string>>()
      const validWorktreeIds = new Set<string>()
      const validVisitKeys = new Set<string>()
      const addValidWorktree = (worktree: { id: string; hostId?: ExecutionHostId }): void => {
        validWorktreeIds.add(worktree.id)
        validVisitKeys.add(getWorktreeVisitKey(worktree.id, worktree.hostId))
      }
      for (const [repoId, list] of Object.entries(s.worktreesByRepo)) {
        // An empty list is the not-yet-hydrated shape, not an authoritative "no worktrees".
        if (s.detectedWorktreesByRepo[repoId] || list.length === 0) {
          continue
        }
        validIdsByRepo.set(repoId, new Set(list.map((worktree) => worktree.id)))
        list.forEach(addValidWorktree)
      }
      for (const [repoId, result] of Object.entries(s.detectedWorktreesByRepo)) {
        if (result.authoritative) {
          validIdsByRepo.set(repoId, new Set(result.worktrees.map((worktree) => worktree.id)))
          result.worktrees.forEach(addValidWorktree)
        }
      }
      let changed = false
      const next: Record<string, number> = {}
      for (const [key, ts] of Object.entries(s.lastVisitedAtByWorktreeId)) {
        const id = getWorktreeIdFromVisitKey(key)
        const repoId = getRepoIdFromWorktreeId(id)
        const repoIds = validIdsByRepo.get(repoId)
        if (!repoIds) {
          // Repo not yet hydrated (e.g. SSH not connected). Keep the entry.
          next[key] = ts
          continue
        }
        // Legacy bare keys remain valid when any host still publishes the id;
        // qualified keys must match the exact host-qualified row.
        if (getWorktreeIdFromVisitKey(key) === key ? repoIds.has(id) : validVisitKeys.has(key)) {
          next[key] = ts
        } else {
          changed = true
        }
      }
      const patch: {
        lastVisitedAtByWorktreeId?: Record<string, number>
        activeWorktreeId?: null
        activeWorkspaceKey?: null
        activeWorkspaceExecutionHostId?: null
      } = {}
      if (changed) {
        patch.lastVisitedAtByWorktreeId = next
      }
      // Why: the persisted active-worktree pointer is a `${repoId}::${path}` id
      // that nothing else reconciles here. The main-process Store clears a stale
      // pointer when a repo is removed (removeWorkspaceSessionOwner nulls
      // activeWorktreeId), but the web client keeps it in localStorage and gets
      // no such load-time GC — so a pointer to a worktree the server no longer
      // reports lingers and can surface a phantom/duplicate workspace. Clear it
      // once its repo is hydrated and the worktree is confirmed gone (defer while
      // the repo is unhydrated, mirroring the timestamp rule above).
      const activeId = s.activeWorktreeId
      if (activeId) {
        const activeRepoWorktreeIds = validIdsByRepo.get(getRepoIdFromWorktreeId(activeId))
        if (activeRepoWorktreeIds && !activeRepoWorktreeIds.has(activeId)) {
          patch.activeWorktreeId = null
          // Leaving the derived workspace key behind would keep the phantom workspace selected.
          // Only the stale worktree's own key is dropped (same equality check as the rename path),
          // so a folder key or a key pointing at another live worktree survives. The bare-id form
          // predates the `worktree:` prefix and is cleared too, matching the purge path.
          if (
            s.activeWorkspaceKey === worktreeWorkspaceKey(activeId) ||
            s.activeWorkspaceKey === activeId
          ) {
            patch.activeWorkspaceKey = null
          }
          patch.activeWorkspaceExecutionHostId = null
        }
      }
      return Object.keys(patch).length > 0 ? patch : {}
    })
  }
}

export function createSeedActiveWorktreeLastVisitedIfMissing(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['seedActiveWorktreeLastVisitedIfMissing'] {
  return () => {
    set((s) => {
      const id = s.activeWorktreeId
      if (!id) {
        return {}
      }
      const hostId = s.activeWorkspaceExecutionHostId ?? s.getKnownWorktreeById(id)?.hostId
      const key = getWorktreeVisitKey(id, hostId)
      if (getWorktreeVisitTimestamp(s.lastVisitedAtByWorktreeId, { id, hostId }) != null) {
        return {}
      }
      return {
        lastVisitedAtByWorktreeId: {
          ...s.lastVisitedAtByWorktreeId,
          [key]: Date.now()
        }
      }
    })
  }
}
