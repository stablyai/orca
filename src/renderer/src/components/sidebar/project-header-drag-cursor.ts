import { useEffect } from 'react'

/**
 * Holds the grabbing cursor and suppresses text selection for the duration of a
 * project-header drag, restoring whatever the document had before.
 */
export function useProjectHeaderDragCursor(isDragging: boolean): void {
  useEffect(() => {
    if (!isDragging) {
      return
    }
    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'grabbing'
    body.style.userSelect = 'none'
    return () => {
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
    }
  }, [isDragging])
}
