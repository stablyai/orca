import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** A parked workspace unmounts its tab strips; each group's offset survives so returning shows the same tabs. */
const offsetByStripKey = new Map<string, { scrollLeft: number; activeTabId: string | null }>()
const MAX_REMEMBERED_STRIPS = 256

function rememberTabStripScroll(key: string, scrollLeft: number, activeTabId: string | null): void {
  offsetByStripKey.delete(key)
  offsetByStripKey.set(key, { scrollLeft, activeTabId })
  if (offsetByStripKey.size > MAX_REMEMBERED_STRIPS) {
    offsetByStripKey.delete(offsetByStripKey.keys().next().value as string)
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
  // Restore once on mount, and only while the same tab is active; a different one keeps its reveal.
  useLayoutEffect(() => {
    const strip = tabStripRef.current
    const saved = key ? offsetByStripKey.get(key) : undefined
    if (key && saved) {
      offsetByStripKey.delete(key)
      if (strip && saved.activeTabId === activeTabId) {
        strip.scrollLeft = saved.scrollLeft
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-only restore.
  }, [key, tabStripRef])
  useEffect(() => {
    const strip = tabStripRef.current
    if (!key || !strip) {
      return
    }
    let scrollLeft = strip.scrollLeft
    const onScroll = (): void => {
      scrollLeft = strip.scrollLeft
    }
    strip.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      strip.removeEventListener('scroll', onScroll)
      rememberTabStripScroll(key, scrollLeft, activeTabIdRef.current)
    }
  }, [key, tabStripRef])
}
