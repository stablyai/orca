import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/** Fades a scroller's clipped edges, so cut-off content reads as more to scroll, not a broken layout. */
export function useScrollEdgeFades<T extends HTMLElement>(): {
  ref: (node: T | null) => void
  className: string
} {
  const [scroller, setScroller] = useState<T | null>(null)
  const [fades, setFades] = useState({ top: false, bottom: false })

  const read = useCallback(() => {
    if (!scroller) {
      return
    }
    const top = scroller.scrollTop > 1
    const bottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 1
    setFades((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom }
    )
  }, [scroller])

  useEffect(() => {
    if (!scroller || typeof ResizeObserver === 'undefined') {
      return
    }
    read()
    scroller.addEventListener('scroll', read, { passive: true })
    // Content can grow without the scroller resizing, e.g. a disclosure opening inside it.
    const resizes = new ResizeObserver(read)
    const observeChildren = (): void => {
      for (const child of scroller.children) {
        resizes.observe(child)
      }
    }
    resizes.observe(scroller)
    observeChildren()
    const mutations = new MutationObserver(() => {
      observeChildren()
      read()
    })
    mutations.observe(scroller, { childList: true })
    return () => {
      scroller.removeEventListener('scroll', read)
      resizes.disconnect()
      mutations.disconnect()
    }
  }, [scroller, read])

  return {
    ref: setScroller,
    className: cn(
      fades.top && 'mask-t-from-[calc(100%-1.5rem)]',
      fades.bottom && 'mask-b-from-[calc(100%-1.5rem)]'
    )
  }
}
