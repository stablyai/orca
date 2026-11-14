// Fallbacks for a dock short of room, cumulative and in this order; the last one only scrolls the dock.
export const NATIVE_CHAT_DOCK_FIT_LEVELS = [
  '',
  'queue',
  'queue composer',
  'queue composer transcript',
  'queue composer transcript card',
  'queue composer transcript card dock'
] as const

export const NATIVE_CHAT_DOCK_FIT_ATTRIBUTE = 'data-native-chat-dock-fit'
const ROOT_SELECTOR = '[data-native-chat-root]'
const DOCK_SELECTOR = '[data-native-chat-dock]'
const PINNED_SELECTOR = '[data-native-chat-dock-pinned]'
const CLIP_SELECTOR = '[data-native-chat-dock-clip]'
const ANIMATING_SELECTOR = '[data-native-chat-dock-animating]'
const UNSQUEEZED_SELECTOR = '[data-native-chat-dock-unsqueezed]'
const FLOOR_SELECTOR = '[data-native-chat-dock-floor-lines]'
export const NATIVE_CHAT_DOCK_OBSERVED_SELECTOR =
  '[data-native-chat-dock-pinned], [data-native-chat-dock-content]'
export const NATIVE_CHAT_DOCK_INVALIDATE_EVENT = 'native-chat-dock-invalidate'
const SLACK = 0.5

export function nativeChatDockFitActive(element: Element): boolean {
  return Boolean(element.closest(ROOT_SELECTOR)?.getAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE))
}

/** Ask the dock to re-fit after a change no observed box shows (a folded list, a new step). */
export function invalidateNativeChatDockFit(element: Element): void {
  element
    .closest(ROOT_SELECTOR)
    ?.querySelector(DOCK_SELECTOR)
    ?.dispatchEvent(new Event(NATIVE_CHAT_DOCK_INVALIDATE_EVENT))
}

function dockItemOf(dock: Element, element: Element): Element | null {
  let item: Element | null = element
  while (item && item.parentElement !== dock) {
    item = item.parentElement
  }
  return item
}

function isRendered(element: Element): boolean {
  return element.getClientRects().length > 0
}

/** Every in-flow item ends inside the dock, and no item was flexed down far enough to clip a pinned part. */
export function nativeChatDockFits(dock: HTMLElement): boolean {
  const box = dock.getBoundingClientRect()
  for (const item of Array.from(dock.children)) {
    if (isRendered(item) && item.getBoundingClientRect().bottom > box.bottom + SLACK) {
      return false
    }
  }
  for (const pinned of Array.from(dock.querySelectorAll(PINNED_SELECTOR))) {
    if (!isRendered(pinned)) {
      continue
    }
    const rect = pinned.getBoundingClientRect()
    // Its own item, so a squeezed item (one the next item then overlaps) cannot pass for fitting.
    const bounds = [box]
    for (const outer of [dockItemOf(dock, pinned), pinned.closest(CLIP_SELECTOR)]) {
      if (outer) {
        bounds.push(outer.getBoundingClientRect())
      }
    }
    if (
      rect.top < Math.max(...bounds.map((bound) => bound.top)) - SLACK ||
      rect.bottom > Math.min(...bounds.map((bound) => bound.bottom)) + SLACK
    ) {
      return false
    }
  }
  // A scroller with a line floor keeps that many lines in view, or all of a shorter text.
  for (const scroller of Array.from(dock.querySelectorAll<HTMLElement>(FLOOR_SELECTOR))) {
    if (!isRendered(scroller)) {
      continue
    }
    const lines = Number(scroller.dataset.nativeChatDockFloorLines)
    const lineHeight = Number.parseFloat(getComputedStyle(scroller).lineHeight)
    const floor = Math.min(scroller.scrollHeight, lines * lineHeight)
    if (Number.isFinite(floor) && scroller.clientHeight + SLACK < floor) {
      return false
    }
  }
  // A shrinking body may not go below its parts' minimums until a fallback lets it scroll.
  for (const body of Array.from(dock.querySelectorAll(UNSQUEEZED_SELECTOR))) {
    if (
      isRendered(body) &&
      body.scrollHeight > body.clientHeight + 1 &&
      getComputedStyle(body).overflowY === 'visible'
    ) {
      return false
    }
  }
  return true
}

/**
 * Try each level from none upward and keep the first that fits; the last level is terminal and is
 * not measured, since the dock then scrolls. The attribute applies before each geometry read, so
 * every measurement is the rendered layout of that level, all before paint.
 */
export function runNativeChatDockFit(root: HTMLElement, dock: HTMLElement): number | null {
  if (dock.querySelector(ANIMATING_SELECTOR)) {
    return null
  }
  const last = NATIVE_CHAT_DOCK_FIT_LEVELS.length - 1
  for (let level = 0; level <= last; level++) {
    const tokens = NATIVE_CHAT_DOCK_FIT_LEVELS[level]!
    if (tokens) {
      root.setAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE, tokens)
    } else {
      root.removeAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE)
    }
    if (level === last || nativeChatDockFits(dock)) {
      return level
    }
  }
  return last
}
