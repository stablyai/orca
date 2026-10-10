import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { getManualRepoOrder } from '../../../../shared/manual-repo-order'
import { splitRepoReorderByHost } from '../slices/repo-reorder-host-split'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from './repo-state'

export function createRepoOrderingActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'setActiveRepo' | 'reorderRepos'> {
  return {
    setActiveRepo: (projectId) => set({ activeRepoId: projectId }),

    reorderRepos: async (orderedIds) => {
      // Optimistically apply the new order for instant sidebar update; resync only if main rejects (racing add/remove).
      const previous = get().repos
      const remainingById = new Map<string, { repos: Repo[]; nextIndex: number }>()
      for (const repo of previous) {
        const existing = remainingById.get(repo.id)
        if (existing) {
          existing.repos.push(repo)
        } else {
          remainingById.set(repo.id, { repos: [repo], nextIndex: 0 })
        }
      }
      const next: Repo[] = []
      for (const id of orderedIds) {
        const remaining = remainingById.get(id)
        const repo = remaining?.repos[remaining.nextIndex]
        if (remaining) {
          remaining.nextIndex += 1
        }
        if (repo) {
          next.push(repo)
        }
      }
      if (next.length !== previous.length) {
        // Caller passed a non-permutation — refuse to apply locally.
        return
      }
      const manualRepoOrder = getManualRepoOrder(next)
      set({
        repos: next,
        manualRepoOrder,
        folderWorkspacePathStatuses: {}
      })
      try {
        // Why: each host persists only its own repos and rejects non-permutations; dispatch one per-host permutation per owner.
        const groups = splitRepoReorderByHost(orderedIds, next, get().settings)
        const [results] = await Promise.all([
          Promise.all(
            groups.map(async (group) => {
              const parsed = parseExecutionHostId(group.hostId)
              const target =
                parsed?.kind === 'runtime'
                  ? ({ kind: 'environment', environmentId: parsed.environmentId } as const)
                  : ({ kind: 'local' } as const)
              return target.kind === 'local'
                ? window.api.repos.reorderForHost({
                    hostId: group.hostId,
                    orderedIds: group.orderedIds
                  })
                : callRuntimeRpc<{ status: 'applied' | 'rejected' }>(
                    target,
                    'repo.reorder',
                    { orderedIds: group.orderedIds },
                    { timeoutMs: 15_000 }
                  )
            })
          ),
          // Why: servers only persist local permutations; the desktop profile owns cross-host order after a cold load.
          window.api.ui.set({ manualRepoOrder })
        ])
        if (results.some((result) => result.status === 'rejected')) {
          await get().fetchReposForAllHosts()
        }
      } catch (err) {
        console.error('Failed to reorder repos:', err)
        await get().fetchReposForAllHosts()
      }
    }
  }
}
