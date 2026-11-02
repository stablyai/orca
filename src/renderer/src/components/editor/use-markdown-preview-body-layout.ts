import { useLayoutEffect, useState, type RefObject } from 'react'
import {
  measureVirtualizedListScrollMargin,
  observeVirtualizedListScrollMargin
} from '../virtualized-list'

export function useMarkdownPreviewBodyLayout(
  bodyRef: RefObject<HTMLDivElement | null>,
  rootRef: RefObject<HTMLDivElement | null>
) {
  const [layout, setLayout] = useState({ margin: 0, height: 0 })
  useLayoutEffect(() => {
    const body = bodyRef.current
    const root = rootRef.current
    if (!body || !root) {
      return
    }
    const measure = (): void => {
      const margin = measureVirtualizedListScrollMargin(body, root)
      const height = root.clientHeight
      setLayout((previous) =>
        previous.margin === margin && previous.height === height ? previous : { margin, height }
      )
    }
    measure()
    return observeVirtualizedListScrollMargin(body, root, measure)
  }, [bodyRef, rootRef])
  return layout
}
