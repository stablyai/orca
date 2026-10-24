import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  resolveWorktreeOperationRoute,
  resolveWorktreeOperationRouteForHost
} from '@/lib/worktree-operation-route'
import { onPairedWebClientHost } from '@/lib/paired-web-client-host'
import { routeForOwner } from '@/lib/worktree-owner-route'
import {
  findWorktreeLineageRow,
  sameWorktreeLineageIdentity,
  type WorktreeLineageIdentity,
  getWorkspaceLineageRows
} from '../../../../shared/sidebar-list/worktree-lineage-projection'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'
import { mergeWorkspaceLineageRecords } from '../../../../shared/resolved-worktree-lineage'
export { getWorkspaceLineageRows as getLineageAncestorIndex } from '../../../../shared/sidebar-list/worktree-lineage-projection'

/**
 * Rank of each key in the frozen sidebar sort order. Keyed on the array the sort
 * hook already holds identity-stable across unrelated store writes.
 */
const sortedWorktreeRankIndexCache = new WeakMap<readonly string[], Map<string, number>>()

export function getSortedWorktreeRankIndex(sortedIds: readonly string[]): Map<string, number> {
  const cached = sortedWorktreeRankIndexCache.get(sortedIds)
  if (cached) {
    return cached
  }
  const index = new Map(sortedIds.map((id, rank) => [id, rank]))
  sortedWorktreeRankIndexCache.set(sortedIds, index)
  return index
}

type LineageState = {
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>
} & Partial<
  Pick<AppState, 'folderWorkspaces' | 'worktreeLineageById' | 'workspaceLineageByChildKey'>
>
const noEdges = {}
type LineageInputs = {
  worktreeMap: Map<string, Worktree>
  lineageById: AppState['worktreeLineageById']
}
const inputCache = new WeakMap<object, WeakMap<object, WeakMap<object, LineageInputs>>>()
export function getLineageInputs(state: LineageState) {
  const worktreeMap = getWorkspaceLineageRows(
    selectWorktreesByRepo(state),
    state.folderWorkspaces
      ? selectFolderWorkspaces({ folderWorkspaces: state.folderWorkspaces })
      : undefined
  )
  const worktreeEdges = state.worktreeLineageById ?? noEdges
  const workspaceEdges = state.workspaceLineageByChildKey ?? noEdges
  // Renderer subscribers need stable snapshots of their immutable source maps.
  let byWorkspaceEdges = inputCache.get(worktreeEdges)
  if (!byWorkspaceEdges) {
    byWorkspaceEdges = new WeakMap()
    inputCache.set(worktreeEdges, byWorkspaceEdges)
  }
  let byRows = byWorkspaceEdges.get(workspaceEdges)
  if (!byRows) {
    byRows = new WeakMap()
    byWorkspaceEdges.set(workspaceEdges, byRows)
  }
  let inputs = byRows.get(worktreeMap)
  if (!inputs) {
    inputs = {
      worktreeMap,
      lineageById: mergeWorkspaceLineageRecords(worktreeEdges, workspaceEdges)
    }
    byRows.set(worktreeMap, inputs)
  }
  return inputs
}

export function requireCurrentLineageRow(
  state: AppState,
  selection: string | WorktreeLineageIdentity,
  queryHost?: ExecutionHostId
): Worktree {
  const row = findWorktreeLineageRow(getLineageInputs(state).worktreeMap, selection)
  const host = row?.hostId ?? queryHost
  const actual =
    row &&
    (host
      ? resolveWorktreeOperationRouteForHost(state, row.id, host)
      : resolveWorktreeOperationRoute(state, row.id))
  const expected =
    row &&
    onPairedWebClientHost(
      state,
      routeForOwner(row) ?? { executionHostId: 'local', runtimeEnvironmentId: null }
    )
  if (
    !row ||
    !actual ||
    !expected ||
    actual.executionHostId !== expected.executionHostId ||
    actual.runtimeEnvironmentId !== expected.runtimeEnvironmentId
  ) {
    throw new Error('The selected workspace changed. Select it again.')
  }
  return row
}
export function requireKnownLineageRow(
  state: AppState,
  selection: WorktreeLineageIdentity,
  queryHost?: ExecutionHostId
): Worktree {
  const row = requireCurrentLineageRow(state, selection, queryHost)
  const known = state.getKnownWorktreeById(row.id, row.hostId ?? queryHost)
  if (!known || !sameWorktreeLineageIdentity(known, row)) {
    throw new Error('The selected workspace changed. Select it again.')
  }
  return row
}
