import type { DashboardAgentRow } from './useDashboardData'

export type AgentRowLineagePresentation = {
  depth: 0 | 1
  isFirstSibling: boolean
  isLastSibling: boolean
  childCount: number
}

export type DashboardAgentRowWithLineage = DashboardAgentRow & {
  lineage: AgentRowLineagePresentation
}

const ROOT_LINEAGE: AgentRowLineagePresentation = {
  depth: 0,
  isFirstSibling: true,
  isLastSibling: true,
  childCount: 0
}

export function applyAgentRowLineage(rows: DashboardAgentRow[]): DashboardAgentRowWithLineage[] {
  if (rows.length <= 1) {
    return rows.map((row) => ({ ...row, lineage: ROOT_LINEAGE }))
  }

  const rowsByPaneKey = new Map(rows.map((row) => [row.paneKey, row]))
  const childrenByParentPaneKey = new Map<string, DashboardAgentRow[]>()
  const childPaneKeys = new Set<string>()

  for (const row of rows) {
    const parentPaneKey = row.entry.orchestration?.parentPaneKey
    if (!parentPaneKey || !rowsByPaneKey.has(parentPaneKey)) {
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

  if (childPaneKeys.size === 0) {
    return rows.map((row) => ({ ...row, lineage: ROOT_LINEAGE }))
  }

  const ordered: DashboardAgentRowWithLineage[] = []
  const emitted = new Set<string>()
  const emitRow = (row: DashboardAgentRow, lineage: AgentRowLineagePresentation): boolean => {
    if (emitted.has(row.paneKey)) {
      return false
    }
    emitted.add(row.paneKey)
    ordered.push({ ...row, lineage })
    return true
  }

  const emitSubtree = (row: DashboardAgentRow, lineage: AgentRowLineagePresentation): void => {
    const children = childrenByParentPaneKey.get(row.paneKey) ?? []
    if (!emitRow(row, { ...lineage, childCount: children.length })) {
      return
    }
    children.forEach((child, index) => {
      emitSubtree(child, {
        // Why: nested dispatches should still stay under their nearest
        // visible parent, but visual depth remains capped so dense sidebar
        // rows don't lose too much prompt width.
        depth: 1,
        isFirstSibling: index === 0,
        isLastSibling: index === children.length - 1,
        childCount: 0
      })
    })
  }

  for (const row of rows) {
    if (childPaneKeys.has(row.paneKey)) {
      continue
    }
    emitSubtree(row, ROOT_LINEAGE)
  }

  for (const row of rows) {
    emitRow(row, ROOT_LINEAGE)
  }

  return ordered
}
