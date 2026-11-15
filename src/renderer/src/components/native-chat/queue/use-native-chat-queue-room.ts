import { useLayoutEffect, useState, type RefObject } from 'react'

export const NATIVE_CHAT_QUEUE_FULL_ROWS = 6
const QUESTION_ROWS = 3
const SHORT_PANE_ROWS = 1
// 660px at the default size, where one spacing unit is 4px; it scales with the chat's text size.
const SHORT_PANE_UNITS = 165

type QueueRoom = { questionOpen: boolean; rowCap: number }

/** How many whole rows the queue shows: fewer under an open question, one in a short pane. */
export function useNativeChatQueueRoom(
  regionRef: RefObject<HTMLElement | null>,
  unitRef: RefObject<HTMLElement | null>
): QueueRoom {
  const [room, setRoom] = useState<QueueRoom>({
    questionOpen: false,
    rowCap: NATIVE_CHAT_QUEUE_FULL_ROWS
  })
  useLayoutEffect(() => {
    const region = regionRef.current
    const root = region?.closest<HTMLElement>('[data-native-chat-root]')
    const dock = region?.closest<HTMLElement>('[data-native-chat-dock]') ?? region?.parentElement
    if (!region || !root || typeof ResizeObserver === 'undefined') {
      return
    }
    const read = (): void => {
      // Sync and async question cards alike are the dock's own items.
      const questionOpen = Boolean(dock?.querySelector(':scope > [data-native-chat-question-card]'))
      const unit = unitRef.current?.getBoundingClientRect().height ?? 0
      const short = unit > 0 && root.clientHeight < unit * SHORT_PANE_UNITS
      const rowCap = short
        ? SHORT_PANE_ROWS
        : questionOpen
          ? QUESTION_ROWS
          : NATIVE_CHAT_QUEUE_FULL_ROWS
      setRoom((prev) =>
        prev.questionOpen === questionOpen && prev.rowCap === rowCap
          ? prev
          : { questionOpen, rowCap }
      )
    }
    read()
    const resize = new ResizeObserver(read)
    resize.observe(root)
    // The unit changes size with the chat's text size; the pane may not.
    if (unitRef.current) {
      resize.observe(unitRef.current)
    }
    const items = dock ? new MutationObserver(read) : null
    if (dock) {
      items?.observe(dock, { childList: true })
    }
    return () => {
      resize.disconnect()
      items?.disconnect()
    }
  }, [regionRef, unitRef])
  return room
}
