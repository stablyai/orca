import { useLayoutEffect, useRef, type RefObject } from 'react'

/** A parked workspace unmounts its tab strips; each group's offset survives so returning shows the same tabs. */
const offsetByStripKey = new Map<string, { scrollLeft: number; tabId: string | null }>()
const MAX_REMEMBERED_STRIPS = 256

function rememberTabStripScroll(key: string, scrollLeft: number, tabId: string | null): void {
  offsetByStripKey.delete(key)
  offsetByStripKey.set(key, { scrollLeft, tabId })
  const oldest = offsetByStripKey.keys().next()
  if (offsetByStripKey.size > MAX_REMEMBERED_STRIPS && !oldest.done) {
    offsetByStripKey.delete(oldest.value)
  }
}

/** Call after the strip navigation hook so this restore lands after its mount-time reveal. */
export function useTabStripScrollMemory(
  key: string | undefined,
  tabStripRef: RefObject<HTMLElement | null>,
  activeTabId: string | null
): void {
  const activeTabIdRef = useRef(activeTabId)
  useLayoutEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])
  useLayoutEffect(() => {
    const strip = tabStripRef.current
    if (!key || !strip) {
      return
    }
    let pending = offsetByStripKey.get(key)
    let observer: ResizeObserver | undefined
    // A hidden prewarm mounts under display:none, where scrollLeft can't apply; wait for a box.
    const applyPending = (): void => {
      if (!pending || strip.clientWidth === 0) {
        return
      }
      // Only while the same tab is active; a different one keeps its reveal.
      if (pending.tabId === activeTabIdRef.current) {
        strip.scrollLeft = pending.scrollLeft
      }
      pending = undefined
      offsetByStripKey.delete(key)
      observer?.disconnect()
    }
    applyPending()
    if (pending) {
      observer = new ResizeObserver(applyPending)
      observer.observe(strip)
    }
    let scrollLeft = strip.scrollLeft
    const onScroll = (): void => {
      scrollLeft = strip.scrollLeft
    }
    strip.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer?.disconnect()
      strip.removeEventListener('scroll', onScroll)
      // An offset never applied stays saved for the next mount.
      if (!pending) {
        rememberTabStripScroll(key, scrollLeft, activeTabIdRef.current)
      }
    }
  }, [key, tabStripRef])
}
