import { useCallback, useEffect, useState } from 'react'
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
  const [hintOpen, setHintOpen] = useState(false)

  useEffect(() => {
    // Why: only nudge once the app is ready and the button is usable on a
    // visible surface. If eligibility drops mid-hint (tab switch, grab
    // started, markup open, blank tab), close it so a forced-open floating
    // layer can't stick over a hidden or disabled control at (0,0).
    if (!persistedUIReady || !eligible) {
      setHintOpen(false)
      return
    }
    if (claimFirstView()) {
      setHintOpen(true)
    }
  }, [eligible, persistedUIReady])

  const dismissHint = useCallback(() => setHintOpen(false), [])
  return { hintOpen, dismissHint }
}
