import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import { isWindowVisible } from '@/lib/window-activity/window-visibility-interval'
import { subscribeWindowParkVisibility } from '@/lib/window-activity/window-park-visibility'
import { isDocumentVisibilityProvenStale } from '@/components/terminal-pane/viewport/visibility/stale-document-visibility'

/** How long an all-resumed report stays on its own. */
const RESUMED_TOAST_MS = 5000

type WindowVisibility = 'visible' | 'stale-hidden' | 'hidden'

function getWindowVisibility(): WindowVisibility {
  if (isWindowVisible()) {
    return 'visible'
  }
  return isDocumentVisibilityProvenStale() ? 'stale-hidden' : 'hidden'
}

/**
 * The report owns its timer because Sonner's stays paused while Chromium reports a focused
 * window as hidden. The countdown runs only while the report can be seen, restarts each time
 * the window regains focus, and holds while the pointer or keyboard focus is on the toast.
 * Opening Details keeps the report until it is closed.
 */
export function useResumeToastAutoDismiss(
  transient: boolean,
  onExpire: () => void,
  rootRef: RefObject<HTMLElement | null>
): { onDetailsOpened: () => void } {
  const [detailsOpened, setDetailsOpened] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const [pointerWithin, setPointerWithin] = useState(false)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  const [focusReturns, setFocusReturns] = useState(0)
  const visibility = useSyncExternalStore(subscribeWindowParkVisibility, getWindowVisibility)
  // A stale hidden flag is disproved only by the focused window; once it blurs, nobody may be looking.
  const visible = visibility === 'visible' || (visibility === 'stale-hidden' && windowFocused)
  const autoDismiss = transient && visible && !detailsOpened && !focusWithin && !pointerWithin

  useEffect(() => {
    const onFocus = (): void => {
      setWindowFocused(true)
      setFocusReturns((count) => count + 1)
    }
    const onBlur = (): void => setWindowFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    // Sonner focuses its own toast element (Alt+T, then Tab), so hold on that boundary, not ours.
    const root = rootRef.current
    const boundary = root?.closest<HTMLElement>('[data-sonner-toast]') ?? root
    if (!boundary) {
      return
    }
    const onPointerEnter = (): void => setPointerWithin(true)
    const onPointerLeave = (): void => setPointerWithin(false)
    const onFocusIn = (): void => setFocusWithin(true)
    const onFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget
      if (!(next instanceof Node) || !boundary.contains(next)) {
        setFocusWithin(false)
      }
    }
    boundary.addEventListener('pointerenter', onPointerEnter)
    boundary.addEventListener('pointerleave', onPointerLeave)
    boundary.addEventListener('focusin', onFocusIn)
    boundary.addEventListener('focusout', onFocusOut)
    return () => {
      boundary.removeEventListener('pointerenter', onPointerEnter)
      boundary.removeEventListener('pointerleave', onPointerLeave)
      boundary.removeEventListener('focusin', onFocusIn)
      boundary.removeEventListener('focusout', onFocusOut)
    }
  }, [rootRef])

  useEffect(() => {
    if (!autoDismiss) {
      return
    }
    const timer = window.setTimeout(onExpire, RESUMED_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [autoDismiss, onExpire, focusReturns])

  return { onDetailsOpened: () => setDetailsOpened(true) }
}
