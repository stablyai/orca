// Back from an item, in the one group that held its row when the list mounted: the row is found by uid
// (an update can move it first) near where it was among the shown rows, unfolding the group, and focused once.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { focusBotItemBackRow } from './bot-item-row-tab-stops'
import { NEAR_ROWS } from './bot-item-row-picks'

export function useBotItemGroupBack({
  items,
  focusUid,
  focusIndex,
  shown,
  open,
  unfold
}: {
  items: readonly BotItem[]
  focusUid: string | null | undefined
  /** Where the row was in this group as the list mounted; -1 when it was in another. */
  focusIndex: number
  shown: number
  open: boolean
  unfold: () => void
}): {
  backItem: BotItem | undefined
  backFocused: () => void
  backRowRef: (node: HTMLElement | null) => void
} {
  const [backDone, setBackDone] = useState(focusIndex < 0)
  // Looked for near where it was (an update moves a row a few places at most), so it costs the same at
  // any list size; one moved further, or past the rows shown, counts as gone.
  const backItem = useMemo(() => {
    if (backDone) {
      return undefined
    }
    const from = Math.max(0, focusIndex - NEAR_ROWS)
    const near = items.slice(from, Math.min(shown, focusIndex + NEAR_ROWS + 1))
    const at = near.findIndex((item) => item.uid === focusUid)
    return at === -1 ? undefined : items[from + at]
  }, [backDone, focusIndex, focusUid, items, shown])
  // A row gone from the group's shown rows, now or later, has nothing to return to.
  if (!backDone && backItem === undefined) {
    setBackDone(true)
  }
  const backFocused = useCallback(() => setBackDone(true), [])
  // Needs you mounts all its rows: its row focuses as it mounts. Other groups' windows focus it as drawn.
  const backRowRef = useCallback(
    (node: HTMLElement | null) => {
      if (node) {
        focusBotItemBackRow(node)
        backFocused()
      }
    },
    [backFocused]
  )
  useEffect(() => {
    if (backItem && !open) {
      unfold()
    }
  }, [backItem, open, unfold])
  return { backItem, backFocused, backRowRef }
}
