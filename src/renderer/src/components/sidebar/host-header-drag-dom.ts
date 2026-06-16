import { normalizeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

export type HostHeaderRect = {
  hostId: ExecutionHostId
  top: number
  bottom: number
}

const HOST_HEADER_ACTION_SELECTOR =
  '[data-host-header-action], button, a, input, textarea, select, [contenteditable=""], [contenteditable="true"]'

export function isHostHeaderActionTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof HTMLElement) || target === currentTarget) {
    return false
  }
  return currentTarget.contains(target) && target.closest(HOST_HEADER_ACTION_SELECTOR) !== null
}

export function readHostHeaderRects(container: HTMLElement): HostHeaderRect[] {
  const containerRect = container.getBoundingClientRect()
  const headerRects: HostHeaderRect[] = []
  for (const header of Array.from(
    container.querySelectorAll<HTMLElement>('[data-host-header-drag-id]')
  )) {
    const hostId = normalizeExecutionHostId(header.dataset.hostHeaderDragId)
    if (!hostId) {
      continue
    }
    const rect = header.getBoundingClientRect()
    headerRects.push({
      hostId,
      top: rect.top - containerRect.top + container.scrollTop,
      bottom: rect.bottom - containerRect.top + container.scrollTop
    })
  }
  return headerRects
}
