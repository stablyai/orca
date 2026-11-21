import { useEffect, useRef, useState, type RefObject } from 'react'

/** Whether the comment's text has its own row above the controls: from its second line, so its lines don't
 *  wrap beside them, until the box empties, so the controls don't jump as the text grows and shrinks.
 *  `tall` (replying to a question) keeps it there from the start, with room for an answer.
 *  `height` sizes the editor: one row growing to six lines, then it scrolls; tall, four lines growing to
 *  eleven. A short pane caps both (`cqh` is the item pane's height), so Activity and Send stay in view. */
export function useBotItemCommentStacked(
  draft: string,
  tall = false
): {
  field: RefObject<HTMLDivElement | null>
  stacked: boolean
  height: string
} {
  const field = useRef<HTMLDivElement | null>(null)
  const [grown, setGrown] = useState(false)
  if (grown && !draft) {
    setGrown(false)
  }
  const stacked = tall || grown || draft.includes('\n')
  useEffect(() => {
    const node = field.current
    // A tall box is stacked whatever its text, so it is not measured: its height is its own floor.
    if (stacked || !node) {
      return
    }
    // One line is the editor's 32px; a second makes it 52.
    const observer = new ResizeObserver(() => setGrown(node.offsetHeight > 40))
    observer.observe(node)
    return () => observer.disconnect()
  }, [stacked])
  const height = tall
    ? 'max-h-[min(232px,25cqh)] min-h-[min(92px,15cqh)]'
    : 'max-h-[min(132px,25cqh)] min-h-8'
  return { field, stacked, height }
}
