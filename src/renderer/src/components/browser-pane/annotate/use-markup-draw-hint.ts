import { useCallback, useRef, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'

// Offer Draw once per install independently of capped tours; keep it open until dismissal or ineligibility, with no timeout.
const MARKUP_DRAW_HINT_SEEN_KEY = 'orca.browser.markup-draw-hint-seen'

// Decline the hint when storage is unavailable to avoid nagging on every open.
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
