import type { DashboardAgentRow } from './useDashboardData'

export type AgentRowLineageTree<T extends DashboardAgentRow> = {
  rootRows: T[]
  childrenByParentPaneKey: Map<string, T[]>
  childPaneKeys: Set<string>
}

function buildPaneKeyByTerminalHandle<T extends DashboardAgentRow>(
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

export function resolveAgentRowParentPaneKey<T extends DashboardAgentRow>(
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

export function buildAgentRowLineageTree<T extends DashboardAgentRow>(
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
  const markReachable = (row: T, ancestorPaneKeys: ReadonlySet<string> = new Set()): void => {
    if (reachablePaneKeys.has(row.paneKey) || ancestorPaneKeys.has(row.paneKey)) {
      return
    }
    reachablePaneKeys.add(row.paneKey)
    const descendantAncestorPaneKeys = new Set(ancestorPaneKeys)
    descendantAncestorPaneKeys.add(row.paneKey)
    for (const childRow of childrenByParentPaneKey.get(row.paneKey) ?? []) {
      markReachable(childRow, descendantAncestorPaneKeys)
    }
  }
  for (const rootRow of rootRows) {
    markReachable(rootRow)
  }

  const unreachableRows = rows.filter((row) => !reachablePaneKeys.has(row.paneKey))
  if (unreachableRows.length === 0) {
    return { rootRows, childrenByParentPaneKey, childPaneKeys }
  }

  const normalizedChildrenByParentPaneKey = new Map(childrenByParentPaneKey)
  const normalizedChildPaneKeys = new Set(childPaneKeys)
  for (const row of unreachableRows) {
    if (!rootRows.some((rootRow) => rootRow.paneKey === row.paneKey)) {
      rootRows.push(row)
    }
    normalizedChildPaneKeys.delete(row.paneKey)
    normalizedChildrenByParentPaneKey.delete(row.paneKey)
    for (const [parentPaneKey, siblings] of normalizedChildrenByParentPaneKey) {
      const visibleSiblings = siblings.filter((sibling) => sibling.paneKey !== row.paneKey)
      if (visibleSiblings.length === 0) {
        normalizedChildrenByParentPaneKey.delete(parentPaneKey)
      } else if (visibleSiblings.length !== siblings.length) {
        normalizedChildrenByParentPaneKey.set(parentPaneKey, visibleSiblings)
      }
    }
  }

  return {
    rootRows,
    childrenByParentPaneKey: normalizedChildrenByParentPaneKey,
    childPaneKeys: normalizedChildPaneKeys
  }
}
