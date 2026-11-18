import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/overlay-interaction/close-all-context-menus'
import { useCallback, useEffect, useRef, useState } from 'react'

/** Opening identity survives animated content; dismissal retires it synchronously. */
export function useSortableTabContextMenu() {
  const generation = useRef(0)
  const [opening, setOpening] = useState({ id: 0, open: false })
  const onOpenChange = useCallback((open: boolean) => {
    const id = ++generation.current
    setOpening((previous) => ({ id: open ? id : previous.id, open }))
  }, [])
  useEffect(() => {
    const closeMenu = (): void => onOpenChange(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [onOpenChange])

  // Why: webview clicks miss the renderer pointerdown Radix uses for outside-click, so dismiss on window blur instead.
  useEffect(() => {
    if (!opening.open) {
      return
    }
    const dismiss = (): void => onOpenChange(false)
    window.addEventListener('blur', dismiss)
    return () => window.removeEventListener('blur', dismiss)
  }, [opening.open, onOpenChange])

  const onComplete = () => {
    if (generation.current === opening.id) {
      onOpenChange(false)
    }
  }
  return { open: opening.open, openingId: opening.id, onOpenChange, onComplete }
}
