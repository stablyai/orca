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
} from '../managed-orcad-execution-host'

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

/** Visibility also selects the default host for new workspaces. Keep it for multiple hosts; explicitly write "all" to prevent legacy-scope fallback. */
export function workspaceHostScopeForVisibleHosts(
  visibleHostIds: readonly ExecutionHostId[] | null,
  current: ExecutionHostScope
): ExecutionHostScope {
  if (visibleHostIds === null) {
    return 'all'
  }
  return visibleHostIds.length === 1 ? visibleHostIds[0] : current
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
