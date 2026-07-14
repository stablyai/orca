import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'

// One-time discovery highlight for the screenshot-markup Draw button. Shows once
// per install — the first time the button is usable — so users notice the new
// tool. Gated on its own localStorage flag (not a contextual tour), so it fires
// for everyone, including users who already finished the capped browser tour.
const MARKUP_DRAW_HINT_SEEN_KEY = 'orca.browser.markup-draw-hint-seen'
const MARKUP_DRAW_HINT_DURATION_MS = 6000

export type MarkupDrawHint = { hintOpen: boolean; dismissHint: () => void }

export function useMarkupDrawHint(eligible: boolean): MarkupDrawHint {
  const persistedUIReady = useAppStore((state) => state.persistedUIReady)
  const [hintOpen, setHintOpen] = useState(false)

  useEffect(() => {
    // Why: wait for persisted UI state so the hint can't flash before the app is
    // ready, and only nudge when the button is actually usable.
    if (!persistedUIReady || !eligible) {
      return undefined
    }
    let alreadySeen = false
    try {
      alreadySeen = window.localStorage.getItem(MARKUP_DRAW_HINT_SEEN_KEY) === 'true'
      if (!alreadySeen) {
        window.localStorage.setItem(MARKUP_DRAW_HINT_SEEN_KEY, 'true')
      }
    } catch {
      // Why: private-mode / disabled storage — skip the hint rather than throw.
      return undefined
    }
    if (alreadySeen) {
      return undefined
    }
    setHintOpen(true)
    const timeoutId = window.setTimeout(() => setHintOpen(false), MARKUP_DRAW_HINT_DURATION_MS)
    return () => window.clearTimeout(timeoutId)
  }, [eligible, persistedUIReady])

  const dismissHint = useCallback(() => setHintOpen(false), [])
  return { hintOpen, dismissHint }
}
