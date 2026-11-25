import { useCallback, useEffect, useRef, type RefObject } from 'react'

type Anchor = { node: Element; top: number }

/** The first row the viewport's top edge crosses or sits above, descending into partly hidden rows. */
function topRow(scroller: HTMLElement, content: HTMLElement): Element {
  const edge = scroller.getBoundingClientRect().top
  let node: Element = content
  for (;;) {
    const next = [...node.children].find((child) => child.getBoundingClientRect().bottom > edge)
    if (!next) {
      return node
    }
    if (next.getBoundingClientRect().top >= edge || next.children.length === 0) {
      return next
    }
    node = next
  }
}

/** Keeps a reader who left the end on the row they were reading while content above it changes
 * (earlier activity loads, an image or card grows): the scroller opts out of browser anchoring. */
export function useBotTranscriptReaderAnchor({
  scrollRef,
  contentRef,
  readerAtEnd,
  scrollTo
}: {
  scrollRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  readerAtEnd: () => boolean
  scrollTo: (offset: number) => void
}): { record: () => void; clear: () => void } {
  const anchor = useRef<Anchor | null>(null)
  const clear = useCallback(() => {
    anchor.current = null
  }, [])
  const record = useCallback(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content || scroller.clientHeight === 0) {
      anchor.current = null
      return
    }
    const node = topRow(scroller, content)
    anchor.current = { node, top: node.getBoundingClientRect().top }
  }, [contentRef, scrollRef])
  useEffect(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      const held = anchor.current
      if (held && held.node.isConnected && !readerAtEnd()) {
        const moved = held.node.getBoundingClientRect().top - held.top
        if (moved !== 0) {
          scrollTo(scroller.scrollTop + moved)
        }
      }
      record()
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [contentRef, readerAtEnd, record, scrollRef, scrollTo])
  return { record, clear }
}
