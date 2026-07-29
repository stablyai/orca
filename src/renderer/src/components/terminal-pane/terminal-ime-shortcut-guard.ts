import type { IDisposable } from '@xterm/xterm'
import { TERMINAL_IME_OWNED_KEYS } from './xterm-bypass-policy'

// Why: two writers reach one PTY — xterm's onData and the shortcut layer's direct
// transport write — and only the former is ordered against IME output. An IME also
// delivers one mid-composition Shift+Enter as two keydowns, so the shortcut fired
// twice and both writes beat the glyph. Any new direct writer inherits the hazard.

export type TerminalImeShortcutKeyEvent = {
  key: string
  isComposing?: boolean
}

/** How the shortcut layer must treat one keydown. */
export type TerminalImeKeydownVerdict = 'ime-owned' | 'follows-ime-commit' | 'plain'

export type TerminalImeShortcutGuard = IDisposable & {
  /** Call once per keydown, before any shortcut matching. */
  classifyKeydown: (event: TerminalImeShortcutKeyEvent) => TerminalImeKeydownVerdict
}

/**
 * Tracks composition state for the window-level shortcut layer, which cannot
 * reach the per-pane tracker that feeds `shouldSuppressTerminalImeKeyboardEvent`.
 */
export function createTerminalImeShortcutGuard(
  target: EventTarget = window
): TerminalImeShortcutGuard {
  let compositionActive = false
  let compositionFlushPending = false
  const markCompositionStart = (): void => {
    compositionActive = true
    // Why: a new session proves the previous flush already ran.
    compositionFlushPending = false
  }
  const markCompositionEnd = (): void => {
    compositionActive = false
    compositionFlushPending = true
  }
  // Why not a bare `true`: Node's EventTarget matches it only on add, so `dispose`
  // would silently no-op under the node test environment.
  const capture = { capture: true } as const
  target.addEventListener('compositionstart', markCompositionStart, capture)
  target.addEventListener('compositionend', markCompositionEnd, capture)

  return {
    classifyKeydown: (event) => {
      // Why live state, not the keyCode 229 marker: IMEs report 229 outside any
      // composition too, and claiming those drops the shortcut with no second
      // press to redo it. xterm-bypass-policy.ts passes them for the same reason.
      if (
        (compositionActive || event.isComposing === true) &&
        TERMINAL_IME_OWNED_KEYS.has(event.key)
      ) {
        return 'ime-owned'
      }
      const followsImeCommit = compositionFlushPending
      compositionFlushPending = false
      return followsImeCommit ? 'follows-ime-commit' : 'plain'
    },
    dispose: () => {
      target.removeEventListener('compositionstart', markCompositionStart, capture)
      target.removeEventListener('compositionend', markCompositionEnd, capture)
    }
  }
}

/** Runs `write` after any composition text the same key press committed. */
export function writeTerminalShortcutInPtyOrder(
  verdict: TerminalImeKeydownVerdict,
  write: () => void
): void {
  if (verdict !== 'follows-ime-commit') {
    write()
    return
  }
  // Why a timer specifically: it lands after the one compositionend already took,
  // while a microtask or MessageChannel yield would run ahead of that flush.
  setTimeout(write, 0)
}
