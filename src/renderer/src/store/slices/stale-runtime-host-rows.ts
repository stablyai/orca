import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

/**
 * True iff `hostId` names a `runtime:<envId>` host whose environment id is in the
 * removed set. Local, SSH, and unhosted (`hostId` undefined) rows never match.
 * Removal-diff scoping (not "absent from the saved list") is load-bearing: a
 * serving instance's locally-persisted runtime-stamped repos carry an env id that
 * was never in this instance's saved list, so it can never enter the removed diff.
 */
export function isRemovedRuntimeHostId(
  hostId: string | null | undefined,
  removedEnvironmentIds: ReadonlySet<string>
): boolean {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' && removedEnvironmentIds.has(parsed.environmentId)
}

export type DropRuntimeRowsResult<T> = {
  rowsByRepo: Record<string, T[]>
  removedWorktreeIds: string[]
}

/**
 * Drops rows whose `hostId` is a removed-env runtime host from a
 * `worktreesByRepo`-shaped map. Returns the SAME reference when nothing changed
 * (render-churn guard). Repo keys are kept even when their row list empties — the
 * repo itself is purged from `repos`, so grouping never references an empty entry,
 * and keeping keys avoids threading a cross-slice "does this repo survive" callback
 * into a pure helper. Generic so it serves both `Worktree[]` and the detected
 * worktrees' `.worktrees` arrays.
 */
export function dropWorktreeRowsForRemovedRuntimeEnvironments<
  T extends { id: string; hostId?: ExecutionHostId }
>(
  rowsByRepo: Record<string, T[]>,
  removedEnvironmentIds: ReadonlySet<string>
): DropRuntimeRowsResult<T> {
  if (removedEnvironmentIds.size === 0) {
    return { rowsByRepo, removedWorktreeIds: [] }
  }
  let changed = false
  const removedWorktreeIds: string[] = []
  const next: Record<string, T[]> = {}
  for (const [repoId, rows] of Object.entries(rowsByRepo)) {
    const survivors = rows.filter((row) => {
      if (isRemovedRuntimeHostId(row.hostId, removedEnvironmentIds)) {
        removedWorktreeIds.push(row.id)
        return false
      }
      return true
    })
    next[repoId] = survivors.length === rows.length ? rows : survivors
    if (survivors.length !== rows.length) {
      changed = true
    }
  }
  return changed ? { rowsByRepo: next, removedWorktreeIds } : { rowsByRepo, removedWorktreeIds: [] }
}
