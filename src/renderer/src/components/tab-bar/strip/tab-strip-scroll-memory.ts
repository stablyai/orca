import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useAppStore } from '@/store/index'

/** A parked workspace unmounts its tab strips; each group's offset survives so returning shows the same tabs. */
const offsetByStripKey = new Map<string, { scrollLeft: number; tabId: string | null }>()
const PRUNE_FLOOR = 64
let pruneAtSize = PRUNE_FLOOR

// Entries live as long as their group; closed groups are swept once the map doubles, so the cost stays amortized O(1).
function pruneClosedGroupOffsets(): void {
  const openGroupIds = new Set<string>()
  for (const groups of Object.values(useAppStore.getState().groupsByWorktree)) {
    for (const group of groups) {
      openGroupIds.add(group.id)
    }
  }
  for (const key of offsetByStripKey.keys()) {
    if (!openGroupIds.has(key)) {
      offsetByStripKey.delete(key)
    }
  }
  pruneAtSize = Math.max(PRUNE_FLOOR, offsetByStripKey.size * 2)
}

function rememberTabStripScroll(key: string, scrollLeft: number, tabId: string | null): void {
  offsetByStripKey.set(key, { scrollLeft, tabId })
  if (offsetByStripKey.size > pruneAtSize) {
    pruneClosedGroupOffsets()
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
