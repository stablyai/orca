import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'

function getSidebarWorktreeOptions(worktreeId: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-worktree-id]')).filter(
    (element) => element.dataset.worktreeId === worktreeId
  )
}

function isPinnedSidebarWorktreeOption(element: HTMLElement): boolean {
  // Why: duplicated pinned rows share a worktree id; the row-key prefix is the
  // stable row-scoped signal that distinguishes the pinned copy from natural rows.
  return element.dataset.worktreeRowKey?.startsWith('pinned:') === true
}

function findPrimarySidebarWorktreeOption(worktreeId: string): HTMLElement | null {
  const options = getSidebarWorktreeOptions(worktreeId)
  return (
    options.find((element) =>
      element.querySelector<HTMLElement>('[data-worktree-card-active="primary"]')
    ) ??
    options.find((element) => !isPinnedSidebarWorktreeOption(element)) ??
    options[0] ??
    null
  )
}

function findSidebarWorktreeRow(worktreeId: string, rowKey?: string): HTMLElement | null {
  const options = getSidebarWorktreeOptions(worktreeId)
  const option = rowKey
    ? (options.find((element) => element.dataset.worktreeRowKey === rowKey) ?? null)
    : (findPrimarySidebarWorktreeOption(worktreeId) ?? null)
  return option?.closest<HTMLElement>('[data-worktree-virtual-row]') ?? null
}

export function preserveSidebarWorktreePosition(worktreeId: string): () => void {
  if (typeof document === 'undefined') {
    return () => {}
  }
  const getScroller = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-worktree-sidebar]')
  const scroller = getScroller()
  const activeOption = findPrimarySidebarWorktreeOption(worktreeId)
  const activeRowKey = activeOption?.dataset.worktreeRowKey
  const row = activeOption?.closest<HTMLElement>('[data-worktree-virtual-row]') ?? null
  if (!scroller || !row) {
    return () => {}
  }
  scroller.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
  const previousScrollTop = scroller.scrollTop
  const previousScrollHeight = scroller.scrollHeight
  const previousTop = row.getBoundingClientRect().top

  return () => {
    let attempts = 0
    const restore = (): void => {
      const currentScroller = getScroller()
      if (!currentScroller) {
        attempts += 1
        if (attempts < 12) {
          window.requestAnimationFrame(restore)
        }
        return
      }
      const nextRow = findSidebarWorktreeRow(worktreeId, activeRowKey)
      if (!nextRow) {
        // Why: a remount can first render the wrong virtual window. Put the
        // scroller near the same content after height changes so the row
        // mounts, then retry and correct by actual DOM position.
        currentScroller.scrollTop = Math.max(
          0,
          previousScrollTop + currentScroller.scrollHeight - previousScrollHeight
        )
      } else {
        const delta = nextRow.getBoundingClientRect().top - previousTop
        if (Math.abs(delta) > 1) {
          currentScroller.scrollTop += delta
        }
      }
      attempts += 1
      if (attempts < 12) {
        window.requestAnimationFrame(restore)
      }
    }
    window.requestAnimationFrame(restore)
  }
}
