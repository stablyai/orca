import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useAppStore } from '@/store/index'

/** A parked workspace unmounts its tab strips; each group's offset survives so returning shows the same tabs. */
const offsetByStripKey = new Map<string, { scrollLeft: number; tabId: string | null }>()
// Live groups only (closed ones are dropped at unmount); the cap just bounds groups closed while their strip was released.
const MAX_REMEMBERED_STRIPS = 8192

export function isTabStripGroupOpen(worktreeId: string, groupId: string): boolean {
  return useAppStore.getState().groupsByWorktree[worktreeId]?.some((g) => g.id === groupId) ?? false
}

function rememberTabStripScroll(
  key: string,
  worktreeId: string,
  scrollLeft: number,
  tabId: string | null
): void {
  offsetByStripKey.delete(key)
  if (!isTabStripGroupOpen(worktreeId, key)) {
    return
  }
  offsetByStripKey.set(key, { scrollLeft, tabId })
  const oldest = offsetByStripKey.keys().next()
  if (offsetByStripKey.size > MAX_REMEMBERED_STRIPS && !oldest.done) {
    offsetByStripKey.delete(oldest.value)
  }
}

/** The strip unmounted earlier with its group still open (its workspace released the layout). */
export function isTabStripReturning(key: string | undefined): boolean {
  return key !== undefined && offsetByStripKey.has(key)
}

/** Call after the strip navigation hook so this restore lands after its mount-time reveal. */
export function useTabStripScrollMemory(
  key: string | undefined,
  worktreeId: string,
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
        // The native scroll event lands after this resize pass; strip navigation must see the restored offset now,
        // or its end-pinning from the hidden mount moves the strip to the end.
        strip.dispatchEvent(new Event('scroll'))
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
        rememberTabStripScroll(key, worktreeId, scrollLeft, activeTabIdRef.current)
      }
    }
  }, [key, worktreeId, tabStripRef])
}
