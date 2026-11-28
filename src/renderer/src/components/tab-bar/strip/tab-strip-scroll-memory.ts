import { useLayoutEffect, useRef, type RefObject } from 'react'
import { createTabGroupScopedState } from '@/lib/workspace/tabs/tab-group-scoped-state'

/** A parked workspace unmounts its tab strips; each group's offset survives so returning shows the same tabs. */
// Disposed with its group, so entries are bounded by open groups.
const offsetByGroup = createTabGroupScopedState<{ scrollLeft: number; tabId: string | null }>()

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
    let pending = offsetByGroup.get(worktreeId, key)
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
      offsetByGroup.take(worktreeId, key)
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
        offsetByGroup.set(worktreeId, key, { scrollLeft, tabId: activeTabIdRef.current })
      }
    }
  }, [key, worktreeId, tabStripRef])
}
