import type {
  WorktreeSidebarCard,
  WorktreeSidebarCards
} from '../../../../shared/plugins/frames/plugin-frame-bridge'

const ROW_SELECTOR = '[role="option"][data-worktree-id]'

function ownedBy(row: Element, node: Element | null): boolean {
  return node !== null && node.closest(ROW_SELECTOR) === row
}

/** The workspace cards visible in `root`, in CSS pixels from its top-left corner. */
export function readWorktreeSidebarCards(
  root: HTMLElement,
  keyOf: (worktreeId: string) => number,
  includeStatus: boolean
): WorktreeSidebarCards {
  const bounds = root.getBoundingClientRect()
  const hoveredRows = root.querySelectorAll(`${ROW_SELECTOR}:hover`)
  // Lineage children nest inside their parent row, so the last hovered row is the innermost.
  const hoveredRow = hoveredRows.item(hoveredRows.length - 1)
  const cards: WorktreeSidebarCard[] = []
  for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const surface = row.querySelector('[data-worktree-card-surface]')
    if (!surface || !ownedBy(row, surface)) {
      continue
    }
    const rect = surface.getBoundingClientRect()
    if (rect.width === 0 || rect.bottom <= bounds.top || rect.top >= bounds.bottom) {
      continue
    }
    const status = row.querySelector<HTMLElement>('[data-worktree-status]')
    cards.push({
      key: keyOf(row.dataset.worktreeId ?? ''),
      x: Math.round(rect.left - bounds.left),
      y: Math.round(rect.top - bounds.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      hovered: row === hoveredRow,
      active: surface.hasAttribute('data-worktree-card-active'),
      ...(includeStatus && status && ownedBy(row, status)
        ? { status: status.dataset.worktreeStatus }
        : {})
    })
  }
  return { width: Math.round(bounds.width), height: Math.round(bounds.height), cards }
}
