import { useEffect, useRef, useState } from 'react'

/** Kept in sync with the `native-chat-flip-*` animations in terminal.css. */
export const NATIVE_CHAT_FLIP_MS = 260

export type NativeChatFlipState = {
  /** Whether the chat surface should be in the tree. Stays true through the
   *  exit animation so the flip-out is visible before the surface unmounts. */
  rendered: boolean
  /** Animation class for the chat layer, or '' when motion is suppressed. */
  className: string
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Drive the terminal↔chat flip.
 *
 * The chat surface is an overlay above a still-mounted terminal, so the flip is
 * one layer rotating away to reveal the other rather than two faces of a real
 * card — visually identical, and it avoids putting the xterm canvas inside a 3D
 * transform (which forces it onto a composited layer and blurs glyph rendering).
 *
 * Entering is easy: the layer mounts and animates in. Leaving needs the surface
 * held in the tree for the animation's duration, which is what `rendered` does.
 * Under prefers-reduced-motion nothing is held and no class is applied, so the
 * switch is instant.
 */
export function useNativeChatFlip(active: boolean): NativeChatFlipState {
  const [rendered, setRendered] = useState(active)
  const [leaving, setLeaving] = useState(false)
  // Why a ref: the very first render must not animate an already-open chat view
  // (restored session, reload) — only genuine toggles flip.
  const previousActive = useRef(active)
  const reduced = prefersReducedMotion()

  useEffect(() => {
    if (previousActive.current === active) {
      return
    }
    previousActive.current = active
    if (active) {
      setLeaving(false)
      setRendered(true)
      return
    }
    if (reduced) {
      setRendered(false)
      return
    }
    setLeaving(true)
    const timer = setTimeout(() => {
      setLeaving(false)
      setRendered(false)
    }, NATIVE_CHAT_FLIP_MS)
    return () => {
      clearTimeout(timer)
      // Re-entering mid-exit must land on the open state, not a stranded one.
      setLeaving(false)
      setRendered(true)
    }
  }, [active, reduced])

  if (reduced) {
    return { rendered: active, className: '' }
  }
  return {
    rendered: rendered || active,
    className: leaving ? 'native-chat-flip-out' : 'native-chat-flip-in'
  }
}
