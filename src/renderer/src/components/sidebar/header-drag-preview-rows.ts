import {
  createSidebarBlockDragPreview,
  createSidebarDragPreview
} from './worktree-sidebar-pointer-drag-dom'

/** Build the floating drag preview: the whole block (header + children) when
 *  block rows are available, otherwise just the header clone. */
export function createHeaderDragPreview(args: {
  rows: readonly HTMLElement[]
  handleEl: HTMLElement
  pointerX: number
  pointerY: number
}): { preview: HTMLElement; offsetX: number; offsetY: number } {
  return args.rows.length > 1
    ? createSidebarBlockDragPreview({
        rows: args.rows,
        pointerX: args.pointerX,
        pointerY: args.pointerY
      })
    : createSidebarDragPreview({
        sourceRow: args.handleEl,
        pointerX: args.pointerX,
        pointerY: args.pointerY,
        draggedCount: 1
      })
}

/** Collect the virtual-row elements that make up a dragged header's block, so
 *  the drag preview can show the children (worktrees / nested groups), not just
 *  the header. Walks forward from the header's virtual row until the block
 *  boundary — the next header for a project, or the next same-level sibling
 *  group header for a group. */
export function collectHeaderDragBlockRowElements(args: {
  headerEl: HTMLElement
  mode: 'project' | 'group'
  /** For group drag: the dragged group's parent attribute (`''` for top-level);
   *  the block ends at the next group header at that same level. */
  parentAttr?: string
}): HTMLElement[] {
  const headerRow = args.headerEl.closest<HTMLElement>('[data-worktree-virtual-row]')
  if (!headerRow) {
    return []
  }
  const rows: HTMLElement[] = [headerRow]
  let element = headerRow.nextElementSibling
  while (element instanceof HTMLElement) {
    if (element.matches('[data-worktree-virtual-row]')) {
      if (isHeaderDragBlockBoundary(element, args)) {
        break
      }
      rows.push(element)
    }
    element = element.nextElementSibling
  }
  return rows
}

function isHeaderDragBlockBoundary(
  row: HTMLElement,
  args: { mode: 'project' | 'group'; parentAttr?: string }
): boolean {
  const groupHeader = row.querySelector('[data-project-group-header-id]')
  if (args.mode === 'project') {
    // A project block ends at the next header of any kind.
    return row.querySelector('[data-repo-header-id]') !== null || groupHeader !== null
  }
  // A group block extends through its nested rows; it ends at the next group
  // header at the dragged group's own level (a sibling).
  if (groupHeader === null) {
    return false
  }
  return (groupHeader.getAttribute('data-project-group-parent') ?? '') === (args.parentAttr ?? '')
}
