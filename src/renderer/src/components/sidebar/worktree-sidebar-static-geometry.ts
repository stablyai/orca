export type WorktreeSidebarStaticRect = Pick<
  DOMRect,
  'left' | 'right' | 'top' | 'bottom' | 'height'
>

export type WorktreeSidebarStaticGeometry = {
  containerTop: number
  scrollTop: number
}

function getWorktreeSidebarStaticGeometry(container: HTMLElement): WorktreeSidebarStaticGeometry {
  return {
    containerTop: container.getBoundingClientRect().top,
    scrollTop: container.scrollTop
  }
}

export function getWorktreeSidebarStaticRect(
  container: HTMLElement,
  element: HTMLElement,
  geometry?: WorktreeSidebarStaticGeometry
): WorktreeSidebarStaticRect {
  const rect = element.getBoundingClientRect()
  const virtualRow = element.closest<HTMLElement>('[data-worktree-virtual-row]')
  const virtualRowStart = getWorktreeSidebarVirtualRowStart(virtualRow)
  if (!virtualRow || virtualRowStart === null) {
    return rect
  }

  const staticGeometry = geometry ?? getWorktreeSidebarStaticGeometry(container)
  const top =
    staticGeometry.containerTop -
    staticGeometry.scrollTop +
    virtualRowStart +
    rect.top -
    (virtualRow === element ? rect.top : virtualRow.getBoundingClientRect().top)
  return {
    left: rect.left,
    right: rect.right,
    top,
    bottom: top + rect.height,
    height: rect.height
  }
}

export function getWorktreeSidebarVirtualRowStart(virtualRow: HTMLElement | null): number | null {
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
