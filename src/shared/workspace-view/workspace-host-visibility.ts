import {
  normalizeExecutionHostScope,
  normalizeVisibleExecutionHostIds,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../execution-host'
import {
  expandEquivalentExecutionHostIds,
  pickerExecutionHosts,
  type MergedExecutionHost
} from '../execution-host/managed-orcad-execution-host'

/** The shown hosts; with no list saved, the legacy single-host scope still narrows (null is all). */
export function resolveVisibleWorkspaceHostIds(
  visibleWorkspaceHostIds: readonly string[] | null | undefined,
  workspaceHostScope: string | null | undefined
): ExecutionHostId[] | null {
  const visibleHostIds = normalizeVisibleExecutionHostIds(visibleWorkspaceHostIds)
  if (visibleHostIds) {
    return visibleHostIds
  }
  const legacyScope = normalizeExecutionHostScope(workspaceHostScope)
  return legacyScope === 'all' ? null : [legacyScope]
}

/** Minimal picker-row shape: an id plus any equivalent host IDs merged into the same row. */
export type WorkspaceHostRowLike = {
  id: ExecutionHostId
  aliasHostIds?: readonly ExecutionHostId[]
  /** Set on a row that a managed SSH host merged away; such rows are not picker rows. */
  mergedIntoHostId?: ExecutionHostId
}

/** Visibility also selects the default host for new workspaces. With several host rows visible no hidden scope may survive (#41140). */
export function workspaceHostScopeForVisibleHosts(
  visibleHostIds: readonly ExecutionHostId[] | null,
  hostRows?: readonly WorkspaceHostRowLike[]
): ExecutionHostScope {
  if (visibleHostIds === null) {
    return 'all'
  }
  if (visibleHostIds.length === 1) {
    return visibleHostIds[0]
  }
  if (hostRows) {
    // A merged row (managed SSH + its runtime) saves several equivalent IDs; that is still one host row.
    const visible = new Set(visibleHostIds)
    const touchedRows = hostRows.filter(
      (row) =>
        !row.mergedIntoHostId && [row.id, ...(row.aliasHostIds ?? [])].some((id) => visible.has(id))
    )
    if (touchedRows.length === 1) {
      return touchedRows[0].id
    }
  }
  return 'all'
}

/** Picker rows a saved visibility list selects; a row counts when any id it stands for is saved. */
export function getCheckedHostRows<T extends MergedExecutionHost>(
  rows: readonly T[],
  visibleHostIds: readonly ExecutionHostId[]
): T[] {
  const visible = new Set(visibleHostIds)
  return rows.filter(
    (row) => visible.has(row.id) || (row.aliasHostIds ?? []).some((id) => visible.has(id))
  )
}

/** Refuse the last checked row’s removal. Write every ID a merged row represents so exact-ID filters match each owner. */
export function toggleVisibleHostRow(
  hosts: readonly MergedExecutionHost[],
  visibleHostIds: readonly ExecutionHostId[] | null,
  row: MergedExecutionHost
): ExecutionHostId[] | null | undefined {
  const rowIds = expandEquivalentExecutionHostIds(hosts, [row.id])
  if (!visibleHostIds) {
    return rowIds
  }
  const rows = pickerExecutionHosts(hosts)
  const checkedRows = getCheckedHostRows(rows, visibleHostIds)
  const next = new Set(visibleHostIds)
  if (checkedRows.some((checked) => checked.id === row.id)) {
    if (checkedRows.length <= 1) {
      return undefined
    }
    rowIds.forEach((id) => next.delete(id))
  } else {
    rowIds.forEach((id) => next.add(id))
  }
  return getCheckedHostRows(rows, [...next]).length === rows.length ? null : [...next]
}

/** "All hosts": shows every host, or when it already does, narrows to the first row. */
export function toggleAllVisibleHosts(
  hosts: readonly MergedExecutionHost[],
  visibleHostIds: readonly ExecutionHostId[] | null
): ExecutionHostId[] | null | undefined {
  if (visibleHostIds) {
    return null
  }
  const firstHost = pickerExecutionHosts(hosts)[0]
  return firstHost ? expandEquivalentExecutionHostIds(hosts, [firstHost.id]) : undefined
}
