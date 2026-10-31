import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

/** Match only explicitly removed runtime IDs; serving-local runtime stamps may never have belonged to this instance’s saved list, so absence cannot prove removal. */
export function isRemovedRuntimeHostId(
  hostId: string | null | undefined,
  removedEnvironmentIds: ReadonlySet<string>
): boolean {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' && removedEnvironmentIds.has(parsed.environmentId)
}

export type DropRuntimeRowsResult<T> = {
  rowsByRepo: Record<string, T[]>
  removedRows: T[]
}

/** Drop removed-runtime rows; drop legacy unhosted rows only if no repo owner survives. Preserve unchanged references and empty repo keys; supports Worktree and detection arrays. */
export function dropWorktreeRowsForRemovedRuntimeEnvironments<
  T extends { id: string; hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }
>(
  rowsByRepo: Record<string, T[]>,
  removedEnvironmentIds: ReadonlySet<string>,
  repoIdsWithoutSurvivingOwners?: ReadonlySet<string>
): DropRuntimeRowsResult<T> {
  if (removedEnvironmentIds.size === 0) {
    return { rowsByRepo, removedRows: [] }
  }
  let changed = false
  const removedRows: T[] = []
  const next: Record<string, T[]> = {}
  for (const [repoId, rows] of Object.entries(rowsByRepo)) {
    const survivors = rows.filter((row) => {
      if (
        (row.runtimeOwnerEnvironmentId !== undefined &&
          removedEnvironmentIds.has(row.runtimeOwnerEnvironmentId)) ||
        isRemovedRuntimeHostId(row.hostId, removedEnvironmentIds) ||
        (row.hostId === undefined && repoIdsWithoutSurvivingOwners?.has(repoId) === true)
      ) {
        removedRows.push(row)
        return false
      }
      return true
    })
    next[repoId] = survivors.length === rows.length ? rows : survivors
    if (survivors.length !== rows.length) {
      changed = true
    }
  }
  return changed ? { rowsByRepo: next, removedRows } : { rowsByRepo, removedRows: [] }
}

/** Drop removed-runtime catalog headings, preserving unchanged references. */
export function dropRuntimeHostedCatalogRows<T extends { executionHostId?: string | null }>(
  rows: readonly T[],
  removedEnvironmentIds: ReadonlySet<string>
): readonly T[] {
  const kept = rows.filter(
    (row) => !isRemovedRuntimeHostId(row.executionHostId, removedEnvironmentIds)
  )
  return kept.length === rows.length ? rows : kept
}
