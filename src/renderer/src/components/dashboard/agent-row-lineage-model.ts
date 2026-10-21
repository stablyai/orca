import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

/** Minimal row shape the lineage rules need; DashboardAgentRow satisfies it,
 *  and other surfaces (e.g. the Agents thread list) can feed synthetic rows. */
export type AgentLineageSourceRow = {
  paneKey: string
  entry: Pick<AgentStatusEntry, 'terminalHandle' | 'orchestration'>
}

export type AgentRowLineageTree<T extends AgentLineageSourceRow> = {
  rootRows: T[]
  childrenByParentPaneKey: Map<string, T[]>
  childPaneKeys: Set<string>
}

function buildPaneKeyByTerminalHandle<T extends AgentLineageSourceRow>(
  rows: readonly T[]
): Map<string, string> {
  const paneKeyByTerminalHandle = new Map<string, string>()
  for (const row of rows) {
    if (row.entry.terminalHandle && !paneKeyByTerminalHandle.has(row.entry.terminalHandle)) {
      paneKeyByTerminalHandle.set(row.entry.terminalHandle, row.paneKey)
    }
  }
  return paneKeyByTerminalHandle
}

export function resolveAgentRowParentPaneKey<T extends AgentLineageSourceRow>(
  row: T,
  rowsByPaneKey: ReadonlyMap<string, T>,
  paneKeyByTerminalHandle: ReadonlyMap<string, string>
): string | undefined {
  const explicitParentPaneKey = row.entry.orchestration?.parentPaneKey
  if (
    explicitParentPaneKey &&
    explicitParentPaneKey !== row.paneKey &&
    rowsByPaneKey.has(explicitParentPaneKey)
  ) {
    return explicitParentPaneKey
  }

  const parentTerminalHandles = [
    row.entry.orchestration?.parentTerminalHandle,
    row.entry.orchestration?.coordinatorHandle
  ]
  for (const parentTerminalHandle of parentTerminalHandles) {
    const parentPaneKey = parentTerminalHandle
      ? paneKeyByTerminalHandle.get(parentTerminalHandle)
      : undefined
    if (parentPaneKey && parentPaneKey !== row.paneKey && rowsByPaneKey.has(parentPaneKey)) {
      return parentPaneKey
    }
  }

  return undefined
}

export function buildAgentRowLineageTree<T extends AgentLineageSourceRow>(
  rows: readonly T[]
): AgentRowLineageTree<T> {
  const rowsByPaneKey = new Map<string, T>()
  for (const row of rows) {
    if (!rowsByPaneKey.has(row.paneKey)) {
      rowsByPaneKey.set(row.paneKey, row)
    }
  }
  const paneKeyByTerminalHandle = buildPaneKeyByTerminalHandle(rows)
  const childrenByParentPaneKey = new Map<string, T[]>()
  const childPaneKeys = new Set<string>()

  for (const row of rows) {
    const parentPaneKey = resolveAgentRowParentPaneKey(row, rowsByPaneKey, paneKeyByTerminalHandle)
    if (!parentPaneKey) {
      continue
    }
    childPaneKeys.add(row.paneKey)
    const siblings = childrenByParentPaneKey.get(parentPaneKey)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByParentPaneKey.set(parentPaneKey, [row])
    }
  }

  const rootRows = rows.filter((row) => !childPaneKeys.has(row.paneKey))
  if (rootRows.length === 0 && rows.length > 0) {
    // Why: malformed orchestration metadata can form a closed cycle. Keep every
    // row visible as a flat root instead of hiding all participants.
    return { rootRows: [...rows], childrenByParentPaneKey: new Map(), childPaneKeys: new Set() }
  }

  const reachablePaneKeys = new Set<string>()
  for (const rootRow of rootRows) {
    reachablePaneKeys.add(rootRow.paneKey)
  }
  // Set iteration visits newly added descendants once, including cyclic/duplicate edges.
  for (const paneKey of reachablePaneKeys) {
    for (const childRow of childrenByParentPaneKey.get(paneKey) ?? []) {
      reachablePaneKeys.add(childRow.paneKey)
    }
  }

  const unreachableRows = rows.filter((row) => !reachablePaneKeys.has(row.paneKey))
  if (unreachableRows.length === 0) {
    return { rootRows, childrenByParentPaneKey, childPaneKeys }
  }

  const normalizedChildrenByParentPaneKey = new Map(childrenByParentPaneKey)
  const normalizedChildPaneKeys = new Set(childPaneKeys)
  const promotedPaneKeys = new Set<string>()
  for (const row of unreachableRows) {
    if (promotedPaneKeys.has(row.paneKey)) {
      continue
    }
    promotedPaneKeys.add(row.paneKey)
    rootRows.push(row)
    normalizedChildPaneKeys.delete(row.paneKey)
    // Every child of a reachable parent is reachable, so only these parent lists need removal.
    normalizedChildrenByParentPaneKey.delete(row.paneKey)
  }

  return {
    rootRows,
    childrenByParentPaneKey: normalizedChildrenByParentPaneKey,
    childPaneKeys: normalizedChildPaneKeys
  }
}
