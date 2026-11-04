import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

function observeScrollEdgeFades(scroller: HTMLElement, read: () => void): () => void {
  scroller.addEventListener('scroll', read, { passive: true })
  const resizes = new ResizeObserver(read)
  const observed = new Set<Element>()
  const observeContent = (): void => {
    const content = new Set<Element>([scroller, ...scroller.querySelectorAll('*')])
    for (const element of observed) {
      if (!content.has(element)) {
        resizes.unobserve(element)
        observed.delete(element)
      }
    }
    for (const element of content) {
      if (!observed.has(element)) {
        resizes.observe(element)
        observed.add(element)
      }
    }
  }
  observeContent()
  const mutations = new MutationObserver(() => {
    observeContent()
    read()
  })
  mutations.observe(scroller, { childList: true, subtree: true, characterData: true })
  return () => {
    scroller.removeEventListener('scroll', read)
    resizes.disconnect()
    mutations.disconnect()
  }
}

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
    // Fixed-height wrappers can overflow when nested content grows without resizing the wrapper.
    return observeScrollEdgeFades(scroller, read)
  }, [scroller, read])

  return {
    ref: setScroller,
    className: cn(
      fades.top && 'mask-t-from-[calc(100%-1.5rem)]',
      fades.bottom && 'mask-b-from-[calc(100%-1.5rem)]'
    )
  }
}
