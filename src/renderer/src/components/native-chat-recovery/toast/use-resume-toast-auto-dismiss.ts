import { useEffect, useState, useSyncExternalStore, type FocusEvent } from 'react'
import {
  getWindowParkVisible,
  subscribeWindowParkVisibility
} from '@/lib/window-activity/window-park-visibility'

/** How long an all-resumed report stays on its own. */
const RESUMED_TOAST_MS = 5000

type AutoDismiss = {
  onDetailsOpened: () => void
  interactionHandlers: {
    onPointerEnter: () => void
    onPointerLeave: () => void
    onFocusCapture: () => void
    onBlurCapture: (event: FocusEvent<HTMLElement>) => void
  }
}

export function useResumeToastAutoDismiss(transient: boolean, onExpire: () => void): AutoDismiss {
  const [detailsOpened, setDetailsOpened] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const [pointerWithin, setPointerWithin] = useState(false)
  // Sonner's timer can stay paused when Chromium still reports a focused window as hidden.
  const visible = useSyncExternalStore(subscribeWindowParkVisibility, getWindowParkVisible)
  const autoDismiss = transient && visible && !detailsOpened && !focusWithin && !pointerWithin
  useEffect(() => {
    if (!autoDismiss) {
      return
    }
    const timer = window.setTimeout(() => {
      if (getWindowParkVisible()) {
        onExpire()
      }
    }, RESUMED_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [autoDismiss, onExpire])
  return {
    onDetailsOpened: () => setDetailsOpened(true),
    interactionHandlers: {
      onPointerEnter: () => setPointerWithin(true),
      onPointerLeave: () => setPointerWithin(false),
      onFocusCapture: () => setFocusWithin(true),
      onBlurCapture: (event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          setFocusWithin(false)
        }
      }
    }
  }
}
