import { useCallback, useEffect, useState } from 'react'

/** More of a scroll body sits below its visible bottom (1px slack for fractional layout). */
export function contentContinuesBelow(el: {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight > 1
}

/**
 * Tracks whether a scroll body continues under a sticky footer, so the footer can draw an edge
 * only then (fields would otherwise run straight into its buttons). Returns a callback ref.
 */
export function useContentContinuesBelow(): [(node: HTMLElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [continues, setContinues] = useState(false)
  const ref = useCallback((next: HTMLElement | null) => setNode(next), [])
  useEffect(() => {
    if (!node) {
      setContinues(false)
      return
    }
    const update = (): void => setContinues(contentContinuesBelow(node))
    update()
    node.addEventListener('scroll', update, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    resize?.observe(node)
    // Content height changes (Advanced opening) resize the children, not the scroll box.
    for (const child of Array.from(node.children)) {
      resize?.observe(child)
    }
    return () => {
      node.removeEventListener('scroll', update)
      resize?.disconnect()
    }
  }, [node])
  return [ref, continues]
}
