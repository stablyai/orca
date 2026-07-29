import type { IDisposable } from '@xterm/xterm'
import { TERMINAL_IME_OWNED_KEYS } from './xterm-bypass-policy'

// Why: two writers reach one PTY — xterm's onData path and the shortcut layer's
// direct transport write — and only the former is ordered against IME output.
// A macOS IME delivers one Shift+Enter pressed mid-composition as two keydowns:
// a committing press that ends the composition, then the real press. Both match
// the plain shortcut rules, so the shortcut fired twice, and both writes landed
// ahead of the committed glyph, which xterm only queues on a setTimeout(0) taken
// at compositionend. Anyone adding another direct write inherits that hazard.

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
  }
  const markCompositionEnd = (): void => {
    compositionActive = false
    compositionFlushPending = true
  }
  // Why the options object over a bare `true`: Node's EventTarget only matches
  // the boolean form on add, so a bare `true` would make `dispose` a no-op under
  // the node test environment while still working in the renderer.
  const capture = { capture: true } as const
  target.addEventListener('compositionstart', markCompositionStart, capture)
  target.addEventListener('compositionend', markCompositionEnd, capture)

  return {
    classifyKeydown: (event) => {
      // Why live composition state rather than the keyCode 229 marker: an IME
      // reports 229 outside any composition too — the first key after a macOS
      // input-source switch, and Sogou/fcitx candidate commits — and claiming
      // those would swallow the shortcut with no second press to redo it.
      // xterm-bypass-policy.ts passes exactly those events for the same reason.
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
  // Why: xterm would flush its queued glyph synchronously on this keydown, but
  // the shortcut layer stops propagation before xterm sees it. A same-delay timer
  // queued now runs after the one compositionend already took, restoring order.
  // It must stay a timer: a microtask or a MessageChannel yield would both run
  // ahead of that pending flush and reintroduce the bug.
  setTimeout(write, 0)
}
