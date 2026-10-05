export type NativeViewOcclusionRect = Readonly<{
  left: number
  top: number
  width: number
  height: number
}>

export type NativeViewOcclusionSnapshot = Readonly<{
  revision: number
  windowBlocked: boolean
  rectangles: readonly NativeViewOcclusionRect[]
}>

type Registration = {
  element: Element
  windowWide: boolean
  observer?: ResizeObserver
}

const registrations = new Set<Registration>()
const listeners = new Set<() => void>()
let explicitWindowBlockers = 0
let revision = 0
let snapshot: NativeViewOcclusionSnapshot = { revision, windowBlocked: false, rectangles: [] }
let frame: number | undefined

function rectFor(element: Element): NativeViewOcclusionRect | undefined {
  if (!element.isConnected) {
    return undefined
  }
  const rect = element.getBoundingClientRect()
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return undefined
  }
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function sameRect(a: NativeViewOcclusionRect, b: NativeViewOcclusionRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

function publish(): void {
  if (frame !== undefined) {
    cancelAnimationFrame(frame)
    frame = undefined
  }
  const measured = Array.from(registrations, (entry) => ({ entry, rect: rectFor(entry.element) }))
  const rectangles = measured
    .filter(({ entry, rect }) => !entry.windowWide && rect !== undefined)
    .map(({ rect }) => rect!)
    .filter((rect, index, all) => all.findIndex((other) => sameRect(other, rect)) === index)
  const windowBlocked =
    explicitWindowBlockers > 0 || measured.some(({ entry, rect }) => entry.windowWide && rect)
  const unchanged =
    snapshot.windowBlocked === windowBlocked &&
    snapshot.rectangles.length === rectangles.length &&
    snapshot.rectangles.every((rect, index) => sameRect(rect, rectangles[index]))
  if (!unchanged) {
    snapshot = { revision: ++revision, windowBlocked, rectangles }
    for (const listener of listeners) {
      listener()
    }
  }
  if (registrations.size > 0) {
    schedule()
  }
}

function schedule(): void {
  if (listeners.size > 0 && frame === undefined) {
    frame = requestAnimationFrame(publish)
  }
}

function startObserving(registration: Registration): void {
  if (registration.observer || typeof ResizeObserver === 'undefined') {
    return
  }
  registration.observer = new ResizeObserver(schedule)
  registration.observer.observe(registration.element)
}

function stopObserving(registration: Registration): void {
  registration.observer?.disconnect()
  registration.observer = undefined
}

export function registerNativeViewOcclusionElement(
  element: Element,
  options: { windowWide?: boolean } = {}
): () => void {
  const registration: Registration = { element, windowWide: options.windowWide === true }
  registrations.add(registration)
  if (listeners.size > 0) {
    startObserving(registration)
    publish()
  }
  return () => {
    if (!registrations.delete(registration)) {
      return
    }
    stopObserving(registration)
    if (listeners.size > 0) {
      publish()
    }
  }
}

export function registerNativeViewWindowOcclusion(): () => void {
  explicitWindowBlockers += 1
  let released = false
  if (!snapshot.windowBlocked) {
    snapshot = { ...snapshot, revision: ++revision, windowBlocked: true }
    for (const listener of listeners) {
      listener()
    }
  }
  return () => {
    if (released) {
      return
    }
    released = true
    explicitWindowBlockers -= 1
    if (listeners.size > 0) {
      publish()
    } else if (explicitWindowBlockers === 0) {
      snapshot = { ...snapshot, revision: ++revision, windowBlocked: false }
    }
  }
}

export function subscribeNativeViewOcclusion(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    for (const registration of registrations) {
      startObserving(registration)
    }
    publish()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      if (frame !== undefined) {
        cancelAnimationFrame(frame)
        frame = undefined
      }
      for (const registration of registrations) {
        stopObserving(registration)
      }
    }
  }
}

export function getNativeViewOcclusionSnapshot(): NativeViewOcclusionSnapshot {
  return snapshot
}

export function isNativeViewOccluded(
  bounds: NativeViewOcclusionRect,
  current: NativeViewOcclusionSnapshot = snapshot
): boolean {
  if (current.windowBlocked) {
    return true
  }
  return current.rectangles.some(
    (rect) =>
      bounds.left < rect.left + rect.width &&
      bounds.left + bounds.width > rect.left &&
      bounds.top < rect.top + rect.height &&
      bounds.top + bounds.height > rect.top
  )
}

export function isNativeViewPointOccluded(
  x: number,
  y: number,
  current: NativeViewOcclusionSnapshot = snapshot
): boolean {
  return (
    current.windowBlocked ||
    current.rectangles.some(
      (rect) =>
        x >= rect.left &&
        x <= rect.left + rect.width &&
        y >= rect.top &&
        y <= rect.top + rect.height
    )
  )
}

export function scheduleNativeViewOcclusionMeasurement(): void {
  schedule()
}
