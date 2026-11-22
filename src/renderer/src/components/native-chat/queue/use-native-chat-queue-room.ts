import { useEffectEvent, useLayoutEffect, useState, type RefObject } from 'react'
import { NATIVE_CHAT_DOCK_ITEM_SELECTOR } from '../pane/dock/native-chat-dock-fit'

export const NATIVE_CHAT_QUEUE_FULL_ROWS = 6
const QUESTION_ROWS = 3
const SHORT_PANE_ROWS = 1
// 660px at the default size, where one spacing unit is 4px; it scales with the chat's text size.
const SHORT_PANE_UNITS = 165
const QUESTION_SELECTOR = '[data-native-chat-question-card]'
const QUESTION_MUTATION_SELECTOR = `${QUESTION_SELECTOR}, [data-native-chat-dock-contents]`

/** How many whole rows the queue shows: fewer under an open question, one in a short pane. */
export function useNativeChatQueueRoom(
  regionRef: RefObject<HTMLElement | null>,
  unitRef: RefObject<HTMLElement | null>,
  onCapDecrease: (cap: number) => void
): number {
  const [rowCap, setRowCap] = useState(NATIVE_CHAT_QUEUE_FULL_ROWS)
  const beforeCapDecrease = useEffectEvent(onCapDecrease)
  useLayoutEffect(() => {
    const region = regionRef.current
    const root = region?.closest<HTMLElement>('[data-native-chat-root]')
    const dock = region?.closest<HTMLElement>('[data-native-chat-dock]') ?? region?.parentElement
    if (!region || !root || typeof ResizeObserver === 'undefined') {
      return
    }
    let lastCap = NATIVE_CHAT_QUEUE_FULL_ROWS
    const read = (): void => {
      const questionOpen = Array.from(
        dock?.querySelectorAll(NATIVE_CHAT_DOCK_ITEM_SELECTOR) ?? []
      ).some((item) => item.matches(`${QUESTION_SELECTOR}:not([hidden])`))
      const unit = unitRef.current?.getBoundingClientRect().height ?? 0
      const short = unit > 0 && root.clientHeight < unit * SHORT_PANE_UNITS
      const cap = short
        ? SHORT_PANE_ROWS
        : questionOpen
          ? QUESTION_ROWS
          : NATIVE_CHAT_QUEUE_FULL_ROWS
      if (cap < lastCap) {
        beforeCapDecrease(cap)
      }
      lastCap = cap
      setRowCap(cap)
    }
    read()
    const resize = new ResizeObserver(read)
    resize.observe(root)
    // The unit changes size with the chat's text size; the pane may not.
    if (unitRef.current) {
      resize.observe(unitRef.current)
    }
    const items = new MutationObserver((records) => {
      if (
        records.some(
          ({ target }) =>
            target === dock ||
            (target instanceof Element && target.matches(QUESTION_MUTATION_SELECTOR))
        )
      ) {
        read()
      }
    })
    if (dock) {
      items.observe(dock, { childList: true, subtree: true, attributeFilter: ['hidden'] })
    }
    return () => {
      resize.disconnect()
      items.disconnect()
    }
  }, [regionRef, unitRef])
  return rowCap
}
