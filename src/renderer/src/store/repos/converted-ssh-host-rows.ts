import type { AppState } from '../types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'

type ConvertedHostRows = Pick<
  AppState,
  'repos' | 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'contestedPrimaryHostBySessionKey'
>

/** Remove relay-era catalog rows hidden by main but retained by local refresh. Preserve session/terminals under their source host partition or ownerless saves move them local as stale source state. Runtime-owned primary rows belong to destination and stay. */
export function withoutConvertedSshHostRows(
  state: ConvertedHostRows,
  targetId: string
): Partial<ConvertedHostRows> {
  const hostId = toSshExecutionHostId(targetId)
  const pinned = Object.values(state.worktreesByRepo)
    .flat()
    .filter(
      (worktree) =>
        worktree.hostId === hostId &&
        parseExecutionHostId(state.contestedPrimaryHostBySessionKey[worktree.id])?.kind !==
          'runtime'
    )
  const repos = state.repos.filter((repo) => getRepoExecutionHostId(repo) !== hostId)
  const worktreesByRepo = withoutHostRows(state.worktreesByRepo, hostId)
  let detectedChanged = false
  const detectedWorktreesByRepo = Object.fromEntries(
    Object.entries(state.detectedWorktreesByRepo).map(([repoId, result]) => {
      const worktrees = result.worktrees.filter((worktree) => worktree.hostId !== hostId)
      if (worktrees.length === result.worktrees.length) {
        return [repoId, result]
      }
      detectedChanged = true
      return [repoId, { ...result, worktrees }]
    })
  )
  return {
    ...(repos.length === state.repos.length ? {} : { repos }),
    ...(worktreesByRepo === state.worktreesByRepo ? {} : { worktreesByRepo }),
    ...(detectedChanged ? { detectedWorktreesByRepo } : {}),
    ...(pinned.length > 0
      ? {
          contestedPrimaryHostBySessionKey: {
            ...state.contestedPrimaryHostBySessionKey,
            ...Object.fromEntries(pinned.map((worktree) => [worktree.id, hostId]))
          }
        }
      : {})
  }
}

function withoutHostRows<T extends { hostId?: string }>(
  rowsByRepo: Record<string, T[]>,
  hostId: string
): Record<string, T[]> {
  let changed = false
  const next: Record<string, T[]> = {}
  for (const [repoId, rows] of Object.entries(rowsByRepo)) {
    const kept = rows.filter((row) => row.hostId !== hostId)
    changed ||= kept.length !== rows.length
    next[repoId] = kept.length === rows.length ? rows : kept
  }
  return changed ? next : rowsByRepo
}
