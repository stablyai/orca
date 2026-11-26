import { useEffect, useRef, useState, type RefObject } from 'react'

/** Whether the comment's text has its own row above the controls: from its second line, so its lines don't
 *  wrap beside them, until the box empties, so the controls don't jump as the text grows and shrinks.
 *  `height` sizes the editor: one row growing to six lines, then it scrolls. A short pane caps it (`cqh` is
 *  the item pane's height), so Activity and Send stay in view. */
export function useBotItemCommentStacked(draft: string): {
  field: RefObject<HTMLDivElement | null>
  stacked: boolean
  height: string
} {
  const field = useRef<HTMLDivElement | null>(null)
  const [grown, setGrown] = useState(false)
  if (grown && !draft) {
    setGrown(false)
  }
  const stacked = grown || draft.includes('\n')
  useEffect(() => {
    const node = field.current
    if (stacked || !node) {
      return
    }
    // One line is the editor's 32px; a second makes it 52.
    const observer = new ResizeObserver(() => setGrown(node.offsetHeight > 40))
    observer.observe(node)
    return () => observer.disconnect()
  }, [stacked])
  return { field, stacked, height: 'max-h-[min(132px,25cqh)] min-h-8' }
}
