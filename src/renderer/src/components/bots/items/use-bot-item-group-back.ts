// Back from an item, in the one group that held its row when the list mounted: the row is found by uid
// (an update can move it first) among the group's shown rows, unfolding the group, and focused once.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import type { BotItemGroupId } from '../../../../../shared/bots/bot-item-groups'
import { focusBotItemBackRow } from './bot-item-row-tab-stops'

export function useBotItemGroupBack({
  id,
  items,
  focusUid,
  focusIndex,
  shown,
  open,
  unfold,
  section
}: {
  id: BotItemGroupId
  items: readonly BotItem[]
  focusUid: string | null | undefined
  /** Where the row was in this group as the list mounted; -1 when it was in another. */
  focusIndex: number
  shown: number
  open: boolean
  unfold: () => void
  section: React.RefObject<HTMLElement | null>
}): { backItem: BotItem | undefined; backFocused: () => void } {
  const [backDone, setBackDone] = useState(focusIndex < 0)
  const backItem = useMemo(
    () => (backDone ? undefined : items.slice(0, shown).find((item) => item.uid === focusUid)),
    [backDone, focusUid, items, shown]
  )
  // A row gone from the group's shown rows, now or later, has nothing to return to.
  if (!backDone && backItem === undefined) {
    setBackDone(true)
  }
  const backFocused = useCallback(() => setBackDone(true), [])
  const needsYouBackDone = useRef(false)
  // Needs you's rows are all mounted, so its row is focused here; other groups' windows focus it as drawn.
  useEffect(() => {
    if (!backItem || needsYouBackDone.current) {
      return
    }
    if (!open) {
      unfold()
    } else if (id === 'needs_you') {
      needsYouBackDone.current = true
      focusBotItemBackRow(
        section.current?.querySelector<HTMLElement>(`[data-bot-item="${backItem.number}"]`)
      )
    }
  }, [backItem, open, unfold, id, section])
  return { backItem, backFocused }
}
