import { useEffect, useLayoutEffect, useMemo, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { NativeChatToolRunDrawnRow } from '../../runs/use-native-chat-tool-run-window'
import { workerDockAnchorIndex, type WorkerDockScrollAnchor } from './worker-dock-scroll-anchor'

/** The open card's list reads: details for rows scrolled into view, the scroll position held on the
 *  row it rests on as rows come and go, and the keyboard order (this chat's workers, then the
 *  Other chats rows). */
export function useWorkerDockViewportReads({
  viewport,
  anchor,
  expanded,
  items,
  trailing,
  rows,
  drawn,
  small,
  virtual,
  loadWindow
}: {
  viewport: RefObject<HTMLDivElement | null>
  anchor: RefObject<WorkerDockScrollAnchor | null>
  expanded: boolean
  items: readonly { id: string }[]
  trailing: readonly { id: string }[]
  rows: ReadonlyMap<string, unknown>
  drawn: readonly NativeChatToolRunDrawnRow[]
  small: boolean
  virtual: Virtualizer<HTMLDivElement, HTMLDivElement>
  loadWindow: (id: string) => void
}) {
  // Ask for the details of the first row in view that has none. Not the first drawn row: a focused
  // row stays drawn after End, and the card's order (needs-you first) is not the host's.
  const loadVisibleWindow = useLatestHandler(() => {
    const element = viewport.current
    if (!element || !expanded) {
      return
    }
    const top = element.scrollTop
    const bottom = top + element.clientHeight
    const missing = drawn.find(
      (item) =>
        item.end > top &&
        item.start < bottom &&
        items[item.index] &&
        !rows.has(items[item.index].id)
    )
    if (missing) {
      loadWindow(items[missing.index].id)
    }
  })
  const drawnKey = drawn.map((item) => item.index).join(',')
  useEffect(loadVisibleWindow, [drawnKey, rows, expanded, loadVisibleWindow])
  const preserveAnchor = useLatestHandler(() => {
    if (!anchor.current || !viewport.current) {
      return
    }
    const saved = anchor.current
    const target = workerDockAnchorIndex(saved, items)
    if (target < 0) {
      return
    }
    const offset = small
      ? viewport.current.querySelector<HTMLElement>(`[data-index="${target}"]`)?.offsetTop
      : virtual.getOffsetForIndex(target, 'start')?.[0]
    if (offset !== undefined) {
      viewport.current.scrollTo({ top: offset + saved.offset })
    }
  })
  const itemIds = useMemo(() => items.map((row) => row.id), [items])
  const navIds = useMemo(() => [...itemIds, ...trailing.map((row) => row.id)], [itemIds, trailing])
  const identityOrder = itemIds.join('|')
  useLayoutEffect(preserveAnchor, [identityOrder, rows, preserveAnchor])
  return { loadVisibleWindow, navIds }
}
