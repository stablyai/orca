import type { RenderRow } from '../listing/render-row'

export type ProjectGroupDrop =
  | { kind: 'reorder' }
  | { kind: 'into-group'; groupId: string; onHeader: boolean }
  | { kind: 'to-root' }
  | { kind: 'none' }

export type SidebarRowHit = { index: number; top: number; height: number }

// Header edges keep the reorder slot beside a sibling group; the rest of its section means "into".
const REORDER_EDGE_PX = 6

function getProjectGroupHeaderId(row: RenderRow | undefined): string | undefined {
  return row?.type === 'header' && !row.repo ? (row.projectGroup?.id ?? undefined) : undefined
}

/** For each render row, the project groups enclosing it, outermost first; a group header lists itself. */
export function getProjectGroupAncestorsByRowIndex(rows: readonly RenderRow[]): string[][] {
  const stack: { groupId: string; depth: number }[] = []
  return rows.map((row) => {
    if (row.type === 'host-header' || (row.type === 'header' && !row.repo && !row.projectGroup)) {
      stack.length = 0
    } else if (row.type === 'header') {
      const depth = row.projectGroupDepth ?? 0
      while ((stack.at(-1)?.depth ?? -1) >= depth) {
        stack.pop()
      }
      const groupId = getProjectGroupHeaderId(row)
      if (groupId) {
        stack.push({ groupId, depth })
      }
    }
    return stack.map((entry) => entry.groupId)
  })
}

/** Where a dragged header starts: its innermost group and, in a host-split list, its host section. */
export function getProjectGroupDragSource(
  rows: readonly RenderRow[],
  ancestorsByRowIndex: readonly (readonly string[])[],
  rowIndex: number
): { sourceGroupId: string | null; sourceHostId?: string } {
  let sourceHostId: string | undefined
  for (let index = rowIndex; index >= 0; index -= 1) {
    const row = rows[index]
    if (row?.type === 'host-header') {
      sourceHostId = row.hostId
      break
    }
  }
  return { sourceGroupId: ancestorsByRowIndex[rowIndex]?.at(-1) ?? null, sourceHostId }
}

/** The mounted row under a scroll-content Y; the row under the pointer is always rendered. */
export function findSidebarRowAtContentY(
  container: HTMLElement,
  localY: number
): SidebarRowHit | null {
  const containerRect = container.getBoundingClientRect()
  let best: SidebarRowHit | null = null
  for (const element of container.querySelectorAll<HTMLElement>(
    '[data-worktree-virtual-row][data-index]'
  )) {
    const index = Number(element.dataset.index)
    const rect = element.getBoundingClientRect()
    const start = Number(element.dataset.worktreeVirtualRowStart)
    const top = Number.isFinite(start) ? start : rect.top - containerRect.top + container.scrollTop
    if (!Number.isFinite(index) || top > localY || (best && best.top > top)) {
      continue
    }
    best = { index, top, height: rect.height }
  }
  return best
}

export function resolveProjectGroupDrop(args: {
  localY: number
  hit: SidebarRowHit | null
  rows: readonly RenderRow[]
  ancestorsByRowIndex: readonly (readonly string[])[]
  /** Group the dragged item sits in now; null at the top level. */
  sourceGroupId: string | null
  /** Groups listed beside the dragged item in its reorder list. */
  reorderSiblingGroupIds: ReadonlySet<string>
  canDropInto: (groupId: string) => boolean
}): ProjectGroupDrop {
  if (!args.hit) {
    return { kind: 'none' }
  }
  const groupId = args.ancestorsByRowIndex[args.hit.index]?.at(-1)
  if (!groupId) {
    return args.sourceGroupId === null ? { kind: 'reorder' } : { kind: 'to-root' }
  }
  if (groupId === args.sourceGroupId) {
    return { kind: 'reorder' }
  }
  const onHeader = getProjectGroupHeaderId(args.rows[args.hit.index]) === groupId
  if (onHeader && args.reorderSiblingGroupIds.has(groupId)) {
    const offset = args.localY - args.hit.top
    const isCollapsed = !args.ancestorsByRowIndex[args.hit.index + 1]?.includes(groupId)
    if (offset < REORDER_EDGE_PX || (isCollapsed && offset >= args.hit.height - REORDER_EDGE_PX)) {
      return { kind: 'reorder' }
    }
  }
  return args.canDropInto(groupId) ? { kind: 'into-group', groupId, onHeader } : { kind: 'none' }
}

/** The top-level reorder keys of one host section, or of the whole list when it has no host sections. */
export function getRootProjectHeaderKeysForHost(
  keys: readonly string[] | undefined,
  hostId: string | undefined
): readonly string[] | undefined {
  if (!keys) {
    return undefined
  }
  if (!keys.some((key) => key.startsWith('host:'))) {
    return keys
  }
  const start = hostId === undefined ? -1 : keys.indexOf(`host:${hostId}`)
  if (start === -1) {
    return undefined
  }
  const end = keys.findIndex((key, index) => index > start && key.startsWith('host:'))
  return keys.slice(start + 1, end === -1 ? keys.length : end)
}

/**
 * Root order keys and slot that place a just-ungrouped entry at sidebarDropIndex of rootKeys,
 * which do not yet list it. The order commit ignores slots beside the dragged key, so put the
 * key on the side away from the slot.
 */
export function getRootOrderDropForUngroupedEntry(args: {
  rootKeys: readonly string[]
  draggedKey: string
  sidebarDropIndex: number
}): { visibleKeys: string[]; dropIndex: number } | null {
  const rootKeys = args.rootKeys.filter((key) => key !== args.draggedKey)
  if (rootKeys.length === 0) {
    return null
  }
  const slot = Math.max(0, Math.min(rootKeys.length, args.sidebarDropIndex))
  return slot === 0
    ? { visibleKeys: [...rootKeys, args.draggedKey], dropIndex: 0 }
    : { visibleKeys: [args.draggedKey, ...rootKeys], dropIndex: slot + 1 }
}
