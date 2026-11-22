import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import {
  NATIVE_CHAT_DOCK_FIT_ATTRIBUTE,
  NATIVE_CHAT_DOCK_INVALIDATE_EVENT,
  NATIVE_CHAT_DOCK_ITEM_SELECTOR,
  NATIVE_CHAT_DOCK_OBSERVED_SELECTOR,
  invalidateNativeChatDockFit,
  runNativeChatDockFit
} from './native-chat-dock-fit'

/** Keep the dock's controls reachable in a short pane: re-fit whenever an observed box or the dock's items change. */
export function useNativeChatDockFit(dockRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const dock = dockRef.current
    // From the dock, not a ref: an ancestor's ref is not attached yet when this child's layout effect runs.
    const root = dock?.closest<HTMLElement>('[data-native-chat-root]')
    if (!root || !dock || typeof ResizeObserver === 'undefined') {
      return
    }
    return watchNativeChatDock(root, dock)
  }, [dockRef])
}

/** Re-fit on any observed size change, newly mounted box, invalidation or capped-field content change; returns the teardown. */
function watchNativeChatDock(root: HTMLElement, dock: HTMLElement): () => void {
  let queued = false
  let disposed = false
  const run = (): void => {
    queued = false
    // A pass queued before teardown must not mark a root the dock has left.
    if (!disposed) {
      const start = performance.now()
      runNativeChatDockFit(root, dock)
      // Dev builds attribute the pass in the performance timeline; production records nothing.
      if (import.meta.env.DEV) {
        performance.measure('native-chat-dock-fit', { start })
      }
    }
  }
  // Coalesce invalidations from one commit; a microtask still runs before the browser paints.
  const schedule = (): void => {
    if (!queued) {
      queued = true
      queueMicrotask(run)
    }
  }
  // Resize callbacks run after layout and before paint, so a level change never shows a stale frame.
  const resize = new ResizeObserver(run)
  const observed = new WeakSet<Element>()
  const observeNew = (): boolean => {
    let added = false
    // The root too: a taller pane grows only the transcript, so no dock box changes to report the room.
    const targets = [
      root,
      dock,
      ...dock.querySelectorAll(NATIVE_CHAT_DOCK_ITEM_SELECTOR),
      ...dock.querySelectorAll(NATIVE_CHAT_DOCK_OBSERVED_SELECTOR)
    ]
    for (const target of targets) {
      if (!observed.has(target)) {
        observed.add(target)
        resize.observe(target)
        added = true
      }
    }
    return added
  }
  observeNew()
  run()
  // Only newly mounted boxes need a pass; removed ones resize their observed parents.
  const mutations = new MutationObserver(() => {
    if (observeNew()) {
      schedule()
    }
  })
  mutations.observe(dock, { childList: true, subtree: true })
  dock.addEventListener(NATIVE_CHAT_DOCK_INVALIDATE_EVENT, schedule)
  // A capped field keeps its box while its text shrinks, so while a fallback holds, a change in
  // its content height (not every keystroke) asks for a pass that may lift the cap.
  const contentHeights = new WeakMap<Element, number>()
  const input = (event: Event): void => {
    const field = event.target
    if (!(field instanceof HTMLElement) || !root.hasAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE)) {
      return
    }
    const height = field.scrollHeight
    if (contentHeights.get(field) !== height) {
      contentHeights.set(field, height)
      schedule()
    }
  }
  dock.addEventListener('input', input)
  return () => {
    disposed = true
    resize.disconnect()
    mutations.disconnect()
    dock.removeEventListener(NATIVE_CHAT_DOCK_INVALIDATE_EVENT, schedule)
    dock.removeEventListener('input', input)
    root.removeAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE)
  }
}

function subscribeToFit(element: Element | null, onChange: () => void): () => void {
  const root = element?.closest('[data-native-chat-root]')
  if (!root) {
    return () => {}
  }
  const observer = new MutationObserver(onChange)
  observer.observe(root, { attributes: true, attributeFilter: [NATIVE_CHAT_DOCK_FIT_ATTRIBUTE] })
  return () => observer.disconnect()
}

/** Mirrors one fit token for semantics (aria-expanded); layout reads the attribute through CSS, not this. */
export function useNativeChatDockFitToken(
  ref: RefObject<HTMLElement | null>,
  token: string
): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToFit(ref.current, onChange),
    [ref]
  )
  return useSyncExternalStore(
    subscribe,
    () =>
      (
        ref.current
          ?.closest('[data-native-chat-root]')
          ?.getAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE) ?? ''
      )
        .split(' ')
        .includes(token),
    () => false
  )
}

/** Ask the dock to re-fit when any of `inputs` changes (a new step, a countdown line): a change that no
 *  observed box shows. Compared by identity, so an unchanged render costs no fit pass. */
export function useNativeChatDockRefit(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  inputs: readonly unknown[]
): void {
  const last = useRef<readonly unknown[] | null>(null)
  useLayoutEffect(() => {
    const previous = last.current
    last.current = inputs
    const changed =
      previous === null ||
      previous.length !== inputs.length ||
      inputs.some((input, i) => !Object.is(input, previous[i]))
    if (active && changed && ref.current) {
      invalidateNativeChatDockFit(ref.current)
    }
  })
}
