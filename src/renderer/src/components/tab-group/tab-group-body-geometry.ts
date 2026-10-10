// Why: every retained pane in a group sits over the same tab-group body, so the
// non-anchor fallback (web client) measures that body once per group instead of
// once per pane, and only while some pane in the group can display.

export type TabGroupBodyRect = {
  top: number
  left: number
  width: number
  height: number
}

type TabGroupBodyRectListener = (rect: TabGroupBodyRect | null) => void

type GroupBodyGeometrySource = {
  groupId: string
  // The positioned element the pane hosts are laid out in; rects are relative to it.
  container: HTMLElement
  listeners: Set<TabGroupBodyRectListener>
  observer: ResizeObserver
  observedBody: HTMLElement | null
  rect: TabGroupBodyRect | null
}

const RECT_MIN_CHANGE_PX = 1

const bodiesByGroupId = new Map<string, HTMLElement>()
const sourcesByGroupId = new Map<string, Set<GroupBodyGeometrySource>>()

function isSameRect(prev: TabGroupBodyRect | null, next: TabGroupBodyRect | null): boolean {
  if (!prev || !next) {
    return prev === next
  }
  // Why: ResizeObserver and xterm fit can otherwise amplify sub-pixel jitter forever.
  return (
    Math.abs(prev.top - next.top) < RECT_MIN_CHANGE_PX &&
    Math.abs(prev.left - next.left) < RECT_MIN_CHANGE_PX &&
    Math.abs(prev.width - next.width) < RECT_MIN_CHANGE_PX &&
    Math.abs(prev.height - next.height) < RECT_MIN_CHANGE_PX
  )
}

function measureSource(source: GroupBodyGeometrySource): void {
  const body = source.observedBody
  let next: TabGroupBodyRect | null = null
  if (body) {
    const containerRect = source.container.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    next = {
      top: bodyRect.top - containerRect.top,
      left: bodyRect.left - containerRect.left,
      width: bodyRect.width,
      height: bodyRect.height
    }
  }
  if (isSameRect(source.rect, next)) {
    return
  }
  source.rect = next
  for (const listener of source.listeners) {
    listener(next)
  }
}

function measureAllSources(): void {
  for (const sources of sourcesByGroupId.values()) {
    for (const source of sources) {
      measureSource(source)
    }
  }
}

function syncObservedBody(source: GroupBodyGeometrySource): void {
  const body = bodiesByGroupId.get(source.groupId) ?? null
  if (body === source.observedBody) {
    return
  }
  if (source.observedBody) {
    source.observer.unobserve(source.observedBody)
  }
  if (body) {
    source.observer.observe(body)
  }
  source.observedBody = body
}

function onGroupBodyChanged(groupId: string): void {
  for (const source of sourcesByGroupId.get(groupId) ?? []) {
    syncObservedBody(source)
    measureSource(source)
  }
}

/** Registers the element that is the body of `groupId`; returns the unregister function. */
export function registerTabGroupBody(groupId: string, body: HTMLElement): () => void {
  bodiesByGroupId.set(groupId, body)
  onGroupBodyChanged(groupId)
  return () => {
    // A remounted panel may already have registered its replacement body.
    if (bodiesByGroupId.get(groupId) !== body) {
      return
    }
    bodiesByGroupId.delete(groupId)
    onGroupBodyChanged(groupId)
  }
}

function acquireSource(groupId: string, container: HTMLElement): GroupBodyGeometrySource {
  let sources = sourcesByGroupId.get(groupId)
  for (const existing of sources ?? []) {
    if (existing.container === container) {
      return existing
    }
  }
  const source: GroupBodyGeometrySource = {
    groupId,
    container,
    listeners: new Set(),
    observer: new ResizeObserver(() => measureSource(source)),
    observedBody: null,
    rect: null
  }
  source.observer.observe(container)
  syncObservedBody(source)
  if (sourcesByGroupId.size === 0) {
    window.addEventListener('resize', measureAllSources)
  }
  if (!sources) {
    sources = new Set()
    sourcesByGroupId.set(groupId, sources)
  }
  sources.add(source)
  return source
}

function releaseSource(source: GroupBodyGeometrySource): void {
  source.observer.disconnect()
  const sources = sourcesByGroupId.get(source.groupId)
  sources?.delete(source)
  if (sources?.size === 0) {
    sourcesByGroupId.delete(source.groupId)
  }
  if (sourcesByGroupId.size === 0) {
    window.removeEventListener('resize', measureAllSources)
  }
}

/**
 * Subscribes to the rect of `groupId`'s body relative to `container`. The
 * listener is called synchronously with the current rect, then on each change.
 */
export function subscribeTabGroupBodyRect(
  groupId: string,
  container: HTMLElement,
  listener: TabGroupBodyRectListener
): () => void {
  const source = acquireSource(groupId, container)
  // Why: observers miss moves without a resize, so a pane that becomes visible re-reads once.
  measureSource(source)
  listener(source.rect)
  // A per-subscription entry keeps unsubscribe idempotent even if one listener subscribes twice.
  const entry: TabGroupBodyRectListener = (rect) => listener(rect)
  source.listeners.add(entry)
  return () => {
    if (!source.listeners.delete(entry)) {
      return
    }
    if (source.listeners.size === 0) {
      releaseSource(source)
    }
  }
}
