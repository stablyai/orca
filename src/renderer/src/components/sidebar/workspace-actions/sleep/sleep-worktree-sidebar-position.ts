import {
  requestVirtualizedScrollAnchorRecord,
  supersedeVirtualizedScrollAnchorRestore
} from '@/hooks/requestVirtualizedScrollAnchorRecord'

function getSidebarWorktreeOptions(worktreeId: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-worktree-id]')).filter(
    (element) => element.dataset.worktreeId === worktreeId
  )
}

function isPinnedSidebarWorktreeOption(element: HTMLElement): boolean {
  // Pinned duplicates share workspace IDs; use the row-key prefix to distinguish their occurrences.
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
  const previousScrollTop = scroller.scrollTop
  const previousScrollHeight = scroller.scrollHeight
  const previousTop = row.getBoundingClientRect().top
  supersedeVirtualizedScrollAnchorRestore(scroller)

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
        // After remount or height changes, approximate the old viewport so the row mounts before correcting its DOM position.
        const target = Math.max(
          0,
          previousScrollTop + currentScroller.scrollHeight - previousScrollHeight
        )
        supersedeVirtualizedScrollAnchorRestore(currentScroller, target)
        currentScroller.scrollTop = target
      } else {
        const delta = nextRow.getBoundingClientRect().top - previousTop
        supersedeVirtualizedScrollAnchorRestore(
          currentScroller,
          Math.abs(delta) > 1 ? currentScroller.scrollTop + delta : undefined
        )
        if (Math.abs(delta) > 1) {
          currentScroller.scrollTop += delta
        }
      }
      attempts += 1
      if (attempts < 12) {
        window.requestAnimationFrame(restore)
      } else {
        requestVirtualizedScrollAnchorRecord(currentScroller)
      }
    }
    window.requestAnimationFrame(restore)
  }
}
