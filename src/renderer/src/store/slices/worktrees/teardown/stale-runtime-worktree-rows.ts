import { recordDraft } from '@/store/keyed-record-transitions'
import { isRemovedRuntimeHostId } from '../../../host-catalog/removed-runtime-host-rows'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

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
  const removedRows: T[] = []
  const draft = recordDraft(rowsByRepo)
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
    if (survivors.length !== rows.length) {
      draft.set(repoId, survivors)
    }
  }
  return { rowsByRepo: draft.finish(), removedRows }
}
