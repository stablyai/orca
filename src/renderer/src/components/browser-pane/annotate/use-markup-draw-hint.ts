import { useCallback, useRef, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'

// One-time discovery highlight for the screenshot-markup Draw button. Shows once
// per install — the first time the button is usable and its surface is active —
// so users notice the new tool. Gated on its own localStorage flag (not a
// contextual tour), so it fires for everyone, including users who already
// finished the capped browser tour.
//
// Stays open until the user dismisses it (outside click / Escape / blur), clicks
// Draw, or the button stops being eligible. No auto-timeout.
const MARKUP_DRAW_HINT_SEEN_KEY = 'orca.browser.markup-draw-hint-seen'

// Records the first-ever view and returns whether this call is that first view.
// Returns false when storage is unavailable so a private-mode session never
// risks nagging on every open.
function claimFirstView(): boolean {
  try {
    if (window.localStorage.getItem(MARKUP_DRAW_HINT_SEEN_KEY) === 'true') {
      return false
    }
    window.localStorage.setItem(MARKUP_DRAW_HINT_SEEN_KEY, 'true')
    return true
  } catch {
    return false
  }
}

export type MarkupDrawHint = { hintOpen: boolean; dismissHint: () => void }

export function useMarkupDrawHint(eligible: boolean): MarkupDrawHint {
  const persistedUIReady = useAppStore((state) => state.persistedUIReady)
  const hintOpenRef = useRef(false)
  const notifyRef = useRef<() => void>(() => {})
  const subscribe = useCallback(
    (notify: () => void): (() => void) => {
      notifyRef.current = notify
      const nextOpen = persistedUIReady && eligible && (hintOpenRef.current || claimFirstView())
      if (hintOpenRef.current !== nextOpen) {
        hintOpenRef.current = nextOpen
        notify()
      }
      return () => {
        if (notifyRef.current === notify) {
          notifyRef.current = () => {}
        }
      }
    },
    [eligible, persistedUIReady]
  )
  const getSnapshot = useCallback(
    () => hintOpenRef.current && persistedUIReady && eligible,
    [eligible, persistedUIReady]
  )
  const hintOpen = useSyncExternalStore(subscribe, getSnapshot, () => false)
  const dismissHint = useCallback(() => {
    hintOpenRef.current = false
    notifyRef.current()
  }, [])
  return { hintOpen, dismissHint }
}
