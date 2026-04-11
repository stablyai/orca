import { useState, useEffect, useRef } from 'react'

const isMac = navigator.userAgent.includes('Mac')
const MOD_KEY = isMac ? 'Meta' : 'Control'

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
 * - Hints vanish instantly on keyup (no fade-out delay).
 * - Window blur resets state to handle Cmd+Tab away without a keyup event.
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

      // If the modifier key itself was pressed (not as part of a combo)
      // Why cross-modifier exclusion: on Mac, Ctrl+Cmd is often a system shortcut
      // (e.g. Ctrl+Cmd+Q to lock screen); on non-Mac, Meta+Ctrl is similarly not
      // an intentional hint request. Exclude the other platform modifier to avoid
      // false-positive hint activation during these combos.
      if (e.key === MOD_KEY && !e.altKey && !e.shiftKey && (isMac ? !e.ctrlKey : !e.metaKey)) {
        if (!timerRef.current) {
          timerRef.current = setTimeout(() => setShowHints(true), 750)
        }
        return
      }

      // Any other key while modifier is held → cancel hint timer.
      // Why: the user is executing a shortcut (e.g. Cmd+N), not requesting
      // the hint overlay.
      clear()
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === MOD_KEY) {
        clear()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    // Why blur: if the user Cmd+Tabs away, the keyup event may never fire
    // inside this window, leaving hints stuck in the visible state.
    window.addEventListener('blur', clear)

    return () => {
      clear()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clear)
    }
  }, [enabled])

  return { showHints }
}
