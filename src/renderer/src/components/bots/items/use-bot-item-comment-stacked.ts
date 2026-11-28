import { useEffect, useState, type RefObject } from 'react'

/** Whether the comment's text has its own row above the controls: from its second line, so its lines don't
 *  wrap beside them, until the box empties, so the controls don't jump as the text grows and shrinks;
 *  and while `crowded` (a question's placeholder cuts beside the controls). `field` is the text's slot.
 *  Under 520px the text, and a question's placeholder, would not fit beside the controls, so it stacks too.
 *  Classes: `slot` places the text's row, `inset` starts stacked text on the chip's and buttons' edge,
 *  `arrows` keeps the arrows their counter's width beside the text and gives them the free space below it.
 *  `height` sizes the editor: one row growing to six lines, then it scrolls. A short pane caps it (`cqh` is
 *  the item pane's height), so Activity and Send stay in view. `leads`: nothing sits above the text, so stacked
 *  text starts as far below the border as chat's composer text (card 8px + 2px = its 6px + 4px). */
export function useBotItemCommentStacked(
  draft: string,
  field: RefObject<HTMLDivElement | null>,
  crowded: boolean,
  leads: boolean
): { slot: string; inset: string; arrows: string; height: string } {
  const [grown, setGrown] = useState(false)
  if (grown && !draft) {
    setGrown(false)
  }
  const stacked = crowded || grown || draft.includes('\n')
  useEffect(() => {
    const node = field.current
    if (stacked || !node) {
      return
    }
    // One line is the editor's 32px; a second makes it 52.
    const observer = new ResizeObserver(() => setGrown(node.offsetHeight > 40))
    observer.observe(node)
    return () => observer.disconnect()
  }, [stacked, field])
  const height = 'max-h-[min(132px,25cqh)] min-h-8'
  if (stacked) {
    return {
      slot: 'order-first basis-full',
      inset: leads ? 'px-0 pt-0.5' : 'px-0',
      arrows: 'flex-1',
      height: leads ? `${height} min-h-7` : height
    }
  }
  return {
    slot: '@max-[520px]/item-pane:order-first @max-[520px]/item-pane:basis-full',
    inset: leads
      ? 'px-1 @max-[520px]/item-pane:px-0 @max-[520px]/item-pane:pt-0.5'
      : 'px-1 @max-[520px]/item-pane:px-0',
    arrows: 'shrink-0 @max-[520px]/item-pane:flex-1',
    height: leads ? `${height} @max-[520px]/item-pane:min-h-7` : height
  }
}
