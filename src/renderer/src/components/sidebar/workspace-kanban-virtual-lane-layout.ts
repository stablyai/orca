import type { VirtualItem } from '@tanstack/react-virtual'

type VirtualLaneLayoutRegistration = {
  spacerElement: HTMLElement
  getItemIds: () => readonly string[]
  getMeasurements: () => readonly Pick<VirtualItem, 'index' | 'start' | 'end'>[]
}

type VirtualLaneLayoutSnapshot = {
  registration: VirtualLaneLayoutRegistration
  itemIds: readonly string[]
  measurements: readonly Pick<VirtualItem, 'index' | 'start' | 'end'>[]
}

export type WorkspaceKanbanVirtualLaneItemRect = {
  id: string
  index: number
  left: number
  top: number
  right: number
  bottom: number
  contentTop: number
  contentBottom: number
}

const virtualLaneLayouts = new WeakMap<HTMLElement, VirtualLaneLayoutRegistration>()

export function registerWorkspaceKanbanVirtualLaneLayout(args: {
  scrollElement: HTMLElement
  spacerElement: HTMLElement
  getItemIds: () => readonly string[]
  getMeasurements: () => readonly Pick<VirtualItem, 'index' | 'start' | 'end'>[]
}): () => void {
  const registration = {
    spacerElement: args.spacerElement,
    getItemIds: args.getItemIds,
    getMeasurements: args.getMeasurements
  }
  virtualLaneLayouts.set(args.scrollElement, registration)
  return () => {
    if (virtualLaneLayouts.get(args.scrollElement) === registration) {
      virtualLaneLayouts.delete(args.scrollElement)
    }
  }
}

/**
 * The lane's item ids in the index space `resolveWorkspaceKanbanVirtualLaneDropIndex`
 * reports — every item in the lane view, not just the mounted virtual window.
 */
export function getWorkspaceKanbanVirtualLaneItemIds(
  scrollElement: HTMLElement
): readonly string[] | null {
  return virtualLaneLayouts.get(scrollElement)?.getItemIds() ?? null
}

export function getWorkspaceKanbanVirtualLaneItemRects(
  scrollElement: HTMLElement
): WorkspaceKanbanVirtualLaneItemRect[] | null {
  const snapshot = getVirtualLaneLayoutSnapshot(scrollElement)
  if (!snapshot) {
    return null
  }

  const spacerRect = snapshot.registration.spacerElement.getBoundingClientRect()
  const containerRect = scrollElement.getBoundingClientRect()
  const contentOffset = spacerRect.top - containerRect.top + scrollElement.scrollTop
  const rects: WorkspaceKanbanVirtualLaneItemRect[] = []
  for (let index = 0; index < snapshot.itemIds.length; index++) {
    const measurement = snapshot.measurements[index]
    if (!isValidMeasurement(measurement, index)) {
      return null
    }
    rects.push({
      id: snapshot.itemIds[index]!,
      index,
      left: spacerRect.left,
      top: spacerRect.top + measurement.start,
      right: spacerRect.right,
      bottom: spacerRect.top + measurement.end,
      contentTop: contentOffset + measurement.start,
      contentBottom: contentOffset + measurement.end
    })
  }
  return rects
}

export function resolveWorkspaceKanbanVirtualLaneDropIndex(
  scrollElement: HTMLElement,
  pointerY: number
): number | null {
  const snapshot = getVirtualLaneLayoutSnapshot(scrollElement)
  if (!snapshot) {
    return null
  }

  const spacerTop = snapshot.registration.spacerElement.getBoundingClientRect().top
  let low = 0
  let high = snapshot.itemIds.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const measurement = snapshot.measurements[middle]
    if (!isValidMeasurement(measurement, middle)) {
      return null
    }
    if (pointerY < spacerTop + (measurement.start + measurement.end) / 2) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  return low
}

export function resolveWorkspaceKanbanVirtualLaneDropIndicatorY(
  scrollElement: HTMLElement,
  dropIndex: number
): number | null {
  const snapshot = getVirtualLaneLayoutSnapshot(scrollElement)
  if (!snapshot) {
    return null
  }
  if (snapshot.itemIds.length === 0) {
    return scrollElement.getBoundingClientRect().top + 14
  }

  const spacerTop = snapshot.registration.spacerElement.getBoundingClientRect().top
  const boundedIndex = Math.max(0, Math.min(snapshot.itemIds.length, dropIndex))
  if (boundedIndex === 0) {
    const first = snapshot.measurements[0]
    return isValidMeasurement(first, 0) ? spacerTop + first.start - 5 : null
  }
  if (boundedIndex === snapshot.itemIds.length) {
    const lastIndex = snapshot.itemIds.length - 1
    const last = snapshot.measurements[lastIndex]
    return isValidMeasurement(last, lastIndex) ? spacerTop + last.end + 5 : null
  }
  const previous = snapshot.measurements[boundedIndex - 1]
  const next = snapshot.measurements[boundedIndex]
  if (!isValidMeasurement(previous, boundedIndex - 1) || !isValidMeasurement(next, boundedIndex)) {
    return null
  }
  return spacerTop + (previous.end + next.start) / 2
}

function getVirtualLaneLayoutSnapshot(
  scrollElement: HTMLElement
): VirtualLaneLayoutSnapshot | null {
  const registration = virtualLaneLayouts.get(scrollElement)
  if (!registration) {
    return null
  }
  const itemIds = registration.getItemIds()
  const measurements = registration.getMeasurements()
  return measurements.length >= itemIds.length ? { registration, itemIds, measurements } : null
}

function isValidMeasurement(
  measurement: Pick<VirtualItem, 'index' | 'start' | 'end'> | undefined,
  index: number
): measurement is Pick<VirtualItem, 'index' | 'start' | 'end'> {
  return Boolean(
    measurement &&
    measurement.index === index &&
    Number.isFinite(measurement.start) &&
    Number.isFinite(measurement.end) &&
    measurement.end >= measurement.start
  )
}
