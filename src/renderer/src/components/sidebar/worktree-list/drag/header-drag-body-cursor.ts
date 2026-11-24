import { useEffect } from 'react'

export function useHeaderDragBodyCursor(dragging: boolean): void {
  useEffect(() => {
    if (!dragging) {
      return
    }
    const body = document.body
    const { cursor: prevCursor, userSelect: prevUserSelect } = body.style
    body.style.cursor = 'grabbing'
    body.style.userSelect = 'none'
    return () => {
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
    }
  }, [dragging])
}
