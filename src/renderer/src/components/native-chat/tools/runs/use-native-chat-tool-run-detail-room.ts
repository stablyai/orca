import { useEffect, useMemo, useState } from 'react'

/** What this row's opened details add, the same quantity the box's cap has always grown by. */
function openedDetailHeight(row: Element): number {
  let height = 0
  for (const detail of row.querySelectorAll<HTMLElement>('[data-native-chat-member-detail]')) {
    height += detail.offsetHeight
  }
  return height
}

/** The room the run's box gives opened details, kept per row so details scrolled out of the
 *  window (or the whole run evicted and back) still count; the total moves by each row's change. */
export function useNativeChatToolRunDetailRoom({
  scrollerRef,
  rowIndexByKey,
  initial
}: {
  scrollerRef: React.RefObject<HTMLDivElement | null>
  rowIndexByKey: ReadonlyMap<string, number>
  initial: ReadonlyMap<string, number> | undefined
}) {
  const [room] = useState(() => {
    const heights = new Map(initial)
    let total = 0
    for (const height of heights.values()) {
      total += height
    }
    let written = -1
    let saved: ReadonlyMap<string, number> = new Map(heights)
    let savedIsCurrent = true
    const write = (): void => {
      const scroller = scrollerRef.current
      if (scroller && total !== written) {
        written = total
        // A variable, not state: a detail animating open would re-render every frame.
        scroller.style.setProperty('--native-chat-opened-detail', `${total}px`)
      }
    }
    const set = (key: string, height: number): void => {
      if ((heights.get(key) ?? 0) === height) {
        return
      }
      savedIsCurrent = false
      total += height - (heights.get(key) ?? 0)
      if (height > 0) {
        heights.set(key, height)
      } else {
        heights.delete(key)
      }
    }
    return {
      record: (key: string, row: Element): void => {
        set(key, openedDetailHeight(row))
        write()
      },
      retire: (present: ReadonlyMap<string, number>): void => {
        for (const key of heights.keys()) {
          if (!present.has(key)) {
            set(key, 0)
          }
        }
        write()
      },
      // Copied only after a height changed: the reader's scrolling saves the same map again.
      snapshot: (): ReadonlyMap<string, number> => {
        if (!savedIsCurrent) {
          saved = new Map(heights)
          savedIsCurrent = true
        }
        return saved
      }
    }
  })
  // Rows that left the run give back their room; the first pass also applies a returning run's room.
  useEffect(() => {
    room.retire(rowIndexByKey)
  }, [room, rowIndexByKey])
  return useMemo(() => ({ record: room.record, snapshot: room.snapshot }), [room])
}
