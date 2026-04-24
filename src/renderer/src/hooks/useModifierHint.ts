import { useState, useEffect, useRef } from 'react'

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
const MOD_KEY = isMac ? 'Meta' : 'Control'
export const CLEAR_MODIFIER_HINTS_EVENT = 'orca:clear-modifier-hints'

type ModifierHintKeyboardEvent = Pick<
  KeyboardEvent,
  'key' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'repeat'
>

export function dispatchClearModifierHints(): void {
  window.dispatchEvent(new Event(CLEAR_MODIFIER_HINTS_EVENT))
}

export function shouldStartModifierHintTimer(e: ModifierHintKeyboardEvent): boolean {
  return e.key === MOD_KEY && !e.altKey && !e.shiftKey && (isMac ? !e.ctrlKey : !e.metaKey)
}

export function shouldClearModifierHintOnKeyUp(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'>
): boolean {
  if (e.key === MOD_KEY) {
    return true
  }

  // Why: some app-level shortcuts are intercepted outside the renderer's
  // normal keydown path, so the combo key's keyup can be our first signal that
  // a completed Cmd/Ctrl chord is no longer a "show hints" gesture.
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

export function isPlatformModifierHeld(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

/**
 * Tracks whether the user is holding the platform modifier key (Cmd on Mac,
 * Ctrl on Linux/Windows) long enough to show number-hint badges on worktree
 * cards.
 *
 * Rules:
 * - Timer starts on modifier keydown (alone, no other modifiers pressed).
 * - After 750 ms of uninterrupted hold, `showHints` becomes true.
 * - Any other key pressed while the modifier is held cancels the timer —
 *   the user is executing a shortcut, not looking for help.
 * - Hints vanish on keyup, on `blur`, on `visibilitychange` to hidden, or
 *   on the next pointerdown/keydown whose modifier flag reports released.
 *   Why the extra signals: keyup can fail to reach this window when focus
 *   lives inside an embedded <webview> or when the OS intercepts the chord
 *   (Cmd+Tab, Cmd+Space). `visibilitychange` is MDN's recommended pattern
 *   for this cleanup. The next-event modifier check catches the remaining
 *   cases the moment the user does anything.
 * - `e.repeat` events are ignored so the timer only starts once.
 */
export function useModifierHint(enabled: boolean = true): { showHints: boolean } {
  const [showHints, setShowHints] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clear = (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setShowHints(false)
    }

    if (!enabled) {
      clear()
      return undefined
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) {
        return
      }

      // Why cross-modifier exclusion: on Mac, Ctrl+Cmd is often a system shortcut
      // (e.g. Ctrl+Cmd+Q to lock screen); on non-Mac, Meta+Ctrl is similarly not
      // an intentional hint request. Exclude the other platform modifier to avoid
      // false-positive hint activation during these combos.
      if (shouldStartModifierHintTimer(e)) {
        if (!timerRef.current) {
          timerRef.current = setTimeout(() => setShowHints(true), 750)
        }
        return
      }

      // Self-heal: if we missed the modifier's keyup (focus was in a webview,
      // OS intercepted the chord, etc.), the next keydown's modifier flag is
      // authoritative.
      if (!isPlatformModifierHeld(e)) {
        clear()
        return
      }

      // Any other key while modifier is held → cancel hint timer.
      // Why: the user is executing a shortcut (e.g. Cmd+N), not requesting
      // the hint overlay.
      clear()
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (shouldClearModifierHintOnKeyUp(e)) {
        clear()
      }
    }

    // Why pointerdown: a click after the modifier was silently released (focus
    // was in a webview while user released Cmd) should hide stale hints
    // immediately, before any other interaction looks wrong.
    const onPointerDown = (e: PointerEvent): void => {
      if (!isPlatformModifierHeld(e)) {
        clear()
      }
    }

    // Why visibilitychange: MDN's recommended cleanup hook for modifier state
    // when the page becomes hidden (app switch, tab switch, minimize). More
    // comprehensive than `blur` alone.
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        clear()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('blur', clear)
    window.addEventListener(CLEAR_MODIFIER_HINTS_EVENT, clear)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clear()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('blur', clear)
      window.removeEventListener(CLEAR_MODIFIER_HINTS_EVENT, clear)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled])

  return { showHints }
}
