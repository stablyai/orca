import type { Row } from './worktree-list-groups'
import type { ProjectGroup, Repo } from '../../../../shared/types'
import type { WorktreeSidebarHeaderDragRect } from './worktree-sidebar-header-drop-preview'

function mapSidebarRootDropIndexToSiblingInsertIndex(args: {
  sidebarDropIndex: number
  sourceIndex: number
  siblingCount: number
}): number {
  // Why: sidebar drop indices include the dragged header; order is computed
  // against the sibling list after that header is removed.
  const adjustedDropIndex =
    args.sourceIndex >= 0 && args.sidebarDropIndex > args.sourceIndex
      ? args.sidebarDropIndex - 1
      : args.sidebarDropIndex
  return Math.max(0, Math.min(args.siblingCount, adjustedDropIndex))
}

/** One root-level sidebar slot: either a top-level Project Group or an ungrouped project. */
export type SidebarRootSlot = { kind: 'project-group'; id: string } | { kind: 'repo'; id: string }

export type RootSlotOrderUpdate =
  | { kind: 'project-group'; groupId: string; tabOrder: number }
  | { kind: 'repo'; repoId: string; projectGroupOrder: number }

export const SIDEBAR_ROOT_SLOT_BUCKET = 'root'

export function encodeSidebarRootSlotKey(slot: SidebarRootSlot): string {
  return slot.kind === 'project-group' ? `project-group:${slot.id}` : `repo:${slot.id}`
}

export function parseSidebarRootSlotKey(key: string): SidebarRootSlot | null {
  if (key.startsWith('project-group:')) {
    const id = key.slice('project-group:'.length)
    return id.length > 0 ? { kind: 'project-group', id } : null
  }
  if (key.startsWith('repo:')) {
    const id = key.slice('repo:'.length)
    return id.length > 0 ? { kind: 'repo', id } : null
  }
  return null
}

export function sidebarRootSlotsEqual(left: SidebarRootSlot, right: SidebarRootSlot): boolean {
  return left.kind === right.kind && left.id === right.id
}

/** Visual root slots from the row model (depth-0 group headers + ungrouped repo headers). */
export function getSidebarOrderedRootSlots(rows: readonly Row[]): SidebarRootSlot[] {
  const slots: SidebarRootSlot[] = []
  for (const row of rows) {
    if (row.type !== 'header') {
      continue
    }
    const depth = row.projectGroupDepth ?? 0
    if (depth !== 0) {
      continue
    }
    if (row.repo) {
      // Why: depth-0 repo headers are root slots (ungrouped or orphaned membership).
      slots.push({ kind: 'repo', id: row.repo.id })
      continue
    }
    if (row.projectGroup && typeof row.projectGroup.id === 'string') {
      slots.push({ kind: 'project-group', id: row.projectGroup.id })
    }
  }
  return slots
}

export function getRootSlotOrderUpdatesForSidebarDrop(args: {
  orderedRootSlots: readonly SidebarRootSlot[]
  dragged: SidebarRootSlot
  sidebarDropIndex: number
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repoById: ReadonlyMap<string, Repo>
}): RootSlotOrderUpdate[] {
  const sourceIndex = args.orderedRootSlots.findIndex((slot) =>
    sidebarRootSlotsEqual(slot, args.dragged)
  )
  if (sourceIndex === -1) {
    return []
  }
  const siblingSlots = args.orderedRootSlots.filter(
    (slot) => !sidebarRootSlotsEqual(slot, args.dragged)
  )
  const siblingDropIndex = mapSidebarRootDropIndexToSiblingInsertIndex({
    sidebarDropIndex: args.sidebarDropIndex,
    sourceIndex,
    siblingCount: siblingSlots.length
  })
  const sourceIndexInSiblings = Math.min(sourceIndex, siblingSlots.length)
  if (siblingDropIndex === sourceIndexInSiblings) {
    return []
  }

  const orderedSlots = siblingSlots.slice()
  orderedSlots.splice(siblingDropIndex, 0, args.dragged)

  const updates: RootSlotOrderUpdate[] = []
  for (const [index, slot] of orderedSlots.entries()) {
    if (slot.kind === 'project-group') {
      const group = args.projectGroupById.get(slot.id)
      if (!group || group.tabOrder === index) {
        continue
      }
      updates.push({ kind: 'project-group', groupId: slot.id, tabOrder: index })
      continue
    }
    const repo = args.repoById.get(slot.id)
    if (!repo || repo.projectGroupOrder === index) {
      continue
    }
    updates.push({ kind: 'repo', repoId: slot.id, projectGroupOrder: index })
  }
  return updates
}

/** Rank used to interleave root groups with ungrouped projects. Explicit
 *  projectGroupOrder shares the axis with group tabOrder; unset sinks after
 *  every group so legacy sidebars stay group-first. */
export function getSidebarRootSlotRank(args: {
  kind: 'project-group' | 'repo'
  tabOrder?: number
  projectGroupOrder?: number | null
  maxRootGroupTabOrder: number
  ungroupedFallbackIndex: number
}): number {
  if (args.kind === 'project-group') {
    return args.tabOrder ?? 0
  }
  const order = args.projectGroupOrder
  if (typeof order === 'number' && Number.isFinite(order)) {
    return order
  }
  const groupFloor = Number.isFinite(args.maxRootGroupTabOrder) ? args.maxRootGroupTabOrder : -1
  return groupFloor + 1 + args.ungroupedFallbackIndex
}

export type SidebarRootSlotDragRect = WorktreeSidebarHeaderDragRect & {
  slotKey: string
}

function getVirtualRowStart(virtualRow: HTMLElement | null): number | null {
  if (!virtualRow) {
    return null
  }
  const rawStart = virtualRow.getAttribute('data-worktree-virtual-row-start')
  if (rawStart === null) {
    return null
  }
  const start = Number(rawStart)
  return Number.isFinite(start) ? start : null
}

function getOptionalNumberAttribute(element: HTMLElement, attribute: string): number | undefined {
  const rawValue = element.getAttribute(attribute)
  if (rawValue === null) {
    return undefined
  }
  const value = Number(rawValue)
  return Number.isFinite(value) ? value : undefined
}

function measureRootSlotElement(
  element: HTMLElement,
  containerRect: DOMRect,
  containerScrollTop: number,
  slotKey: string,
  headerIndex: number,
  sectionEndAttribute: string
): SidebarRootSlotDragRect {
  const rect = element.getBoundingClientRect()
  const virtualRow = element.closest<HTMLElement>('[data-worktree-virtual-row]')
  const virtualRowStart = getVirtualRowStart(virtualRow)
  const top =
    virtualRow && virtualRowStart !== null
      ? virtualRowStart + rect.top - virtualRow.getBoundingClientRect().top
      : rect.top - containerRect.top + containerScrollTop
  return {
    slotKey,
    headerIndex,
    top,
    bottom: top + rect.height,
    sectionBottom: getOptionalNumberAttribute(element, sectionEndAttribute)
  }
}

/** Measure root group headers and ungrouped repo headers as one drop list. */
export function measureSidebarRootSlotDragRects(container: HTMLElement): SidebarRootSlotDragRect[] {
  const containerRect = container.getBoundingClientRect()
  const rects: SidebarRootSlotDragRect[] = []

  container
    .querySelectorAll<HTMLElement>('[data-project-group-header-bucket="root"]')
    .forEach((element) => {
      const groupId = element.getAttribute('data-project-group-header-id')
      const rawHeaderIndex = element.getAttribute('data-project-group-header-index')
      const headerIndex = rawHeaderIndex === null ? Number.NaN : Number(rawHeaderIndex)
      if (!groupId || !Number.isFinite(headerIndex)) {
        return
      }
      rects.push(
        measureRootSlotElement(
          element,
          containerRect,
          container.scrollTop,
          encodeSidebarRootSlotKey({ kind: 'project-group', id: groupId }),
          headerIndex,
          'data-project-group-header-section-end'
        )
      )
    })

  container
    .querySelectorAll<HTMLElement>('[data-repo-header-bucket="ungrouped"]')
    .forEach((element) => {
      const repoId = element.getAttribute('data-repo-header-id')
      const rawHeaderIndex = element.getAttribute('data-repo-header-index')
      const headerIndex = rawHeaderIndex === null ? Number.NaN : Number(rawHeaderIndex)
      if (!repoId || !Number.isFinite(headerIndex)) {
        return
      }
      rects.push(
        measureRootSlotElement(
          element,
          containerRect,
          container.scrollTop,
          encodeSidebarRootSlotKey({ kind: 'repo', id: repoId }),
          headerIndex,
          'data-repo-header-section-end'
        )
      )
    })

  rects.sort((left, right) => left.top - right.top)
  return rects
}

export function applyRootSlotOrderUpdates(args: {
  updates: readonly RootSlotOrderUpdate[]
  onCommitProjectGroupTabOrder: (groupId: string, tabOrder: number) => void
  onCommitProjectGroupOrder: (repoId: string, projectGroupId: string | null, order: number) => void
}): void {
  for (const update of args.updates) {
    if (update.kind === 'project-group') {
      args.onCommitProjectGroupTabOrder(update.groupId, update.tabOrder)
      continue
    }
    args.onCommitProjectGroupOrder(update.repoId, null, update.projectGroupOrder)
  }
}
