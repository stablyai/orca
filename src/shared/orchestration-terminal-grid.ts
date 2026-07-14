import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from './types'

export const ORCHESTRATION_TERMINAL_GRID_MAX_COLUMNS = 6

export function getOrchestrationTerminalGridColumnCount(paneCount: number): number {
  return Math.max(0, Math.min(paneCount, ORCHESTRATION_TERMINAL_GRID_MAX_COLUMNS))
}

function buildEqualAxisTree(
  nodes: readonly TerminalPaneLayoutNode[],
  direction: 'vertical' | 'horizontal'
): TerminalPaneLayoutNode {
  if (nodes.length === 1) {
    return nodes[0]!
  }
  const firstCount = Math.ceil(nodes.length / 2)
  return {
    type: 'split',
    direction,
    first: buildEqualAxisTree(nodes.slice(0, firstCount), direction),
    second: buildEqualAxisTree(nodes.slice(firstCount), direction),
    ratio: firstCount / nodes.length
  }
}

export function collectTerminalLayoutLeafIds(
  root: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!root) {
    return []
  }
  if (root.type === 'leaf') {
    return [root.leafId]
  }
  return [...collectTerminalLayoutLeafIds(root.first), ...collectTerminalLayoutLeafIds(root.second)]
}

export function buildOrchestrationTerminalGridRoot(
  leafIds: readonly string[]
): TerminalPaneLayoutNode | null {
  if (leafIds.length === 0) {
    return null
  }
  const rows: TerminalPaneLayoutNode[] = []
  for (let index = 0; index < leafIds.length; index += ORCHESTRATION_TERMINAL_GRID_MAX_COLUMNS) {
    const rowLeafIds = leafIds.slice(index, index + ORCHESTRATION_TERMINAL_GRID_MAX_COLUMNS)
    rows.push(
      buildEqualAxisTree(
        rowLeafIds.map((leafId) => ({ type: 'leaf', leafId })),
        'vertical'
      )
    )
  }
  return buildEqualAxisTree(rows, 'horizontal')
}

function retainLeafRecords<T>(
  records: Record<string, T> | undefined,
  leafIds: ReadonlySet<string>
): Record<string, T> | undefined {
  if (!records) {
    return undefined
  }
  const retained = Object.fromEntries(
    Object.entries(records).filter(([leafId]) => leafIds.has(leafId))
  ) as Record<string, T>
  return Object.keys(retained).length > 0 ? retained : undefined
}

export function reflowOrchestrationTerminalGrid(
  layout: TerminalLayoutSnapshot,
  leafIds: readonly string[],
  activeLeafId = layout.activeLeafId
): TerminalLayoutSnapshot {
  const retainedLeafIds = new Set(leafIds)
  const nextActiveLeafId =
    activeLeafId && retainedLeafIds.has(activeLeafId) ? activeLeafId : (leafIds[0] ?? null)
  return {
    root: buildOrchestrationTerminalGridRoot(leafIds),
    activeLeafId: nextActiveLeafId,
    expandedLeafId: null,
    layoutMode: 'orchestration-grid',
    ptyIdsByLeafId: retainLeafRecords(layout.ptyIdsByLeafId, retainedLeafIds),
    buffersByLeafId: retainLeafRecords(layout.buffersByLeafId, retainedLeafIds),
    scrollbackRefsByLeafId: retainLeafRecords(layout.scrollbackRefsByLeafId, retainedLeafIds),
    titlesByLeafId: retainLeafRecords(layout.titlesByLeafId, retainedLeafIds)
  }
}

export function addOrchestrationTerminalGridLeaf(
  layout: TerminalLayoutSnapshot | null | undefined,
  args: { leafId: string; ptyId?: string; title?: string | null; activate?: boolean }
): TerminalLayoutSnapshot {
  const current: TerminalLayoutSnapshot = layout ?? {
    root: null,
    activeLeafId: null,
    expandedLeafId: null,
    layoutMode: 'orchestration-grid'
  }
  const leafIds = collectTerminalLayoutLeafIds(current.root)
  if (!leafIds.includes(args.leafId)) {
    leafIds.push(args.leafId)
  }
  const next = reflowOrchestrationTerminalGrid(
    current,
    leafIds,
    args.activate === false ? current.activeLeafId : args.leafId
  )
  if (args.ptyId) {
    next.ptyIdsByLeafId = { ...next.ptyIdsByLeafId, [args.leafId]: args.ptyId }
  }
  if (args.title) {
    next.titlesByLeafId = { ...next.titlesByLeafId, [args.leafId]: args.title }
  }
  return next
}

export function getOrchestrationGridAppendSourceLeafIds(
  root: TerminalPaneLayoutNode | null | undefined
): string[] {
  const leafIds = collectTerminalLayoutLeafIds(root)
  const rowStart =
    Math.floor((Math.max(leafIds.length, 1) - 1) / ORCHESTRATION_TERMINAL_GRID_MAX_COLUMNS) *
    ORCHESTRATION_TERMINAL_GRID_MAX_COLUMNS
  return leafIds.slice(rowStart)
}
