import { WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP } from '../viewport/virtual-rows'

export type MountedVirtualRowBounds = {
  top: number
  bottom: number
}

function parseFiniteAttribute(element: Element | null, attribute: string): number | null {
  if (!element) {
    return null
  }
  const raw = element.getAttribute(attribute)
  if (raw === null) {
    return null
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export function getOptionalNumberAttribute(
  element: HTMLElement,
  attribute: string
): number | undefined {
  const parsed = parseFiniteAttribute(element, attribute)
  return parsed === null ? undefined : parsed
}

export function getHeaderVirtualRowInfo(
  element: HTMLElement,
  container: HTMLElement,
  containerTop: number
): { top: number; height: number; rowIndex: number | null } {
  const rect = element.getBoundingClientRect()
  const virtualRow = element.closest<HTMLElement>('[data-worktree-virtual-row]')
  const virtualRowStart = parseFiniteAttribute(virtualRow, 'data-worktree-virtual-row-start')
  const rowIndex = parseFiniteAttribute(virtualRow, 'data-index')
  const top =
    virtualRow && virtualRowStart !== null
      ? virtualRowStart + rect.top - virtualRow.getBoundingClientRect().top
      : rect.top - containerTop + container.scrollTop
  return { top, height: rect.height, rowIndex }
}

export function indexMountedVirtualRowBounds(
  container: HTMLElement
): Map<number, MountedVirtualRowBounds> {
  const containerTop = container.getBoundingClientRect().top
  const rowsByIndex = new Map<number, MountedVirtualRowBounds>()
  container
    .querySelectorAll<HTMLElement>('[data-worktree-virtual-row][data-index]')
    .forEach((rowEl) => {
      const index = parseFiniteAttribute(rowEl, 'data-index')
      if (index === null) {
        return
      }
      const rect = rowEl.getBoundingClientRect()
      const startAttr = parseFiniteAttribute(rowEl, 'data-worktree-virtual-row-start')
      const top = startAttr !== null ? startAttr : rect.top - containerTop + container.scrollTop
      rowsByIndex.set(index, { top, bottom: top + rect.height })
    })
  return rowsByIndex
}

export function resolveMeasuredSectionBottom(args: {
  headerRowIndex: number | null
  headerBottom: number
  sectionEndIndex: number | undefined
  estimatedSectionBottom: number | undefined
  mountedRows: ReadonlyMap<number, MountedVirtualRowBounds>
}): number | undefined {
  if (args.sectionEndIndex !== undefined) {
    if (args.headerRowIndex !== null && args.sectionEndIndex <= args.headerRowIndex + 1) {
      return args.headerBottom
    }
    const lastRowBounds = args.mountedRows.get(args.sectionEndIndex - 1)
    if (lastRowBounds) {
      return Math.max(args.headerBottom, lastRowBounds.bottom)
    }
    const nextRowBounds = args.mountedRows.get(args.sectionEndIndex)
    if (nextRowBounds) {
      return Math.max(args.headerBottom, nextRowBounds.top - WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP)
    }
  }
  return args.estimatedSectionBottom
}

export function measureSidebarVirtualContentBottom(container: HTMLElement): number {
  const virtualList = container.querySelector<HTMLElement>('[data-worktree-virtual-list]')
  if (virtualList) {
    const rectHeight = virtualList.getBoundingClientRect().height
    if (rectHeight > 0) {
      return rectHeight
    }
    const styleHeight = Number.parseFloat(virtualList.style.height)
    if (Number.isFinite(styleHeight) && styleHeight > 0) {
      return styleHeight
    }
  }
  return container.scrollHeight
}
