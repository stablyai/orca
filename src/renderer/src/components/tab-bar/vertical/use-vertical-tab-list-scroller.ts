import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { findTabStripSlot } from '../strip/tab-strip-slot-geometry'
import { notifyTabStripListeners, useTabStripListenerSubscribe } from '../strip/tab-strip-window'
import type { TabBarItem } from '../model/tab-bar-item-model'
import type { TabBarItemActions } from '../model/use-tab-bar-item-actions'
import { activateTabBarItem, nextVerticalTabIndex } from './vertical-tab-list-model'

const TAB_SELECTOR = '[role="tab"]'

/**
 * The vertical list's scroller: resize notifications for its row window, the active row kept in
 * view, and tablist keys (Up/Down/Home/End move focus, Enter/Space activate the focused row).
 */
export function useVerticalTabListScroller({
  activeSlotId,
  orderedItems,
  actions
}: {
  activeSlotId: string | null
  orderedItems: readonly TabBarItem[]
  actions: TabBarItemActions
}): {
  scrollerRef: RefObject<HTMLDivElement | null>
  subscribeToResize: (listener: () => void) => () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
} {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const listenersRef = useRef(new Set<() => void>())
  const subscribeToResize = useTabStripListenerSubscribe(listenersRef)

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) {
      return
    }
    // Why one observer: the row window and nothing else needs the scroller's height.
    const observer = new ResizeObserver(() => notifyTabStripListeners(listenersRef))
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || activeSlotId === null) {
      return
    }
    // The window keeps the active row mounted wherever it sits, so it always has a slot to reveal.
    findTabStripSlot(scroller, activeSlotId)?.scrollIntoView({ block: 'nearest' })
  }, [activeSlotId])

  const itemsRef = useRef({ orderedItems, actions })
  useLayoutEffect(() => {
    itemsRef.current = { orderedItems, actions }
  })

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current
    const target = event.target
    // Rename inputs and the close buttons inside a row keep their own keys.
    if (!scroller || !(target instanceof HTMLElement) || target.getAttribute('role') !== 'tab') {
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const slotId = target.closest<HTMLElement>('[data-tab-strip-slot]')?.dataset.tabStripSlot
      const item = itemsRef.current.orderedItems.find((candidate) => candidate.id === slotId)
      if (item) {
        event.preventDefault()
        activateTabBarItem(item, itemsRef.current.actions)
      }
      return
    }
    const tabs = Array.from(scroller.querySelectorAll<HTMLElement>(TAB_SELECTOR))
    const next = nextVerticalTabIndex(event.key, tabs.indexOf(target), tabs.length)
    if (next === null) {
      return
    }
    event.preventDefault()
    tabs[next]!.focus()
    tabs[next]!.scrollIntoView({ block: 'nearest' })
  }, [])

  return { scrollerRef, subscribeToResize, onKeyDown }
}
