import { useCallback, useRef, useState } from 'react'

/** Opening identity survives animated content; dismissal retires it synchronously. */
export function useSortableTabContextMenu() {
  const generation = useRef(0)
  const [opening, setOpening] = useState({ id: 0, open: false })
  const onOpenChange = useCallback((open: boolean) => {
    const id = ++generation.current
    setOpening((previous) => ({ id: open ? id : previous.id, open }))
  }, [])
  const onComplete = () => {
    if (generation.current === opening.id) {
      onOpenChange(false)
    }
  }
  return { open: opening.open, openingId: opening.id, onOpenChange, onComplete }
}
