// Why: a newline chord (Shift+Enter / Ctrl+Enter) pressed while an IME
// composition is still open must reach the PTY *after* the composed glyph
// commits. The window-level terminal shortcut handler runs on the keydown, which
// fires before compositionend, so sending the newline there races ahead of the
// pending commit — the composed CJK character is then forwarded after the
// newline and appears pushed down a line. Instead we wait for the composition to
// commit and forward the newline once the glyph is on its way.

// Why: compositionend fires within the same event-loop turn as the committing
// key, so a real commit always resolves well under this bound. The fallback only
// guards against an IME that never emits compositionend, so the newline is not
// silently swallowed.
export const TERMINAL_IME_DEFERRED_NEWLINE_FALLBACK_MS = 200

/**
 * Forwards a terminal byte sequence once, after the active IME composition ends.
 *
 * xterm flushes the committed glyph asynchronously (on the next `input` event or
 * its own `setTimeout(0)` after `compositionend`), so a bubble-phase
 * `compositionend` listener plus one more macrotask hop orders `send()` strictly
 * after xterm's flush. With no terminal element (or no composition to wait on),
 * `send()` runs on the next macrotask so callers get uniform async behavior.
 */
export function sendTerminalInputAfterComposition(
  terminalElement: HTMLElement | null | undefined,
  send: () => void,
  options?: { fallbackMs?: number }
): void {
  if (!terminalElement) {
    window.setTimeout(send, 0)
    return
  }

  const fallbackMs = options?.fallbackMs ?? TERMINAL_IME_DEFERRED_NEWLINE_FALLBACK_MS
  let done = false

  const finish = (): void => {
    if (done) {
      return
    }
    done = true
    terminalElement.removeEventListener('compositionend', onCompositionEnd)
    window.clearTimeout(fallbackTimer)
    // Defer one macrotask so xterm's own post-compositionend glyph flush runs
    // before our newline reaches the PTY.
    window.setTimeout(send, 0)
  }

  const onCompositionEnd = (): void => finish()

  // Bubble phase (not capture) so this runs after xterm's textarea-level
  // compositionend handler, keeping our deferred send ordered after its flush.
  terminalElement.addEventListener('compositionend', onCompositionEnd)
  const fallbackTimer = window.setTimeout(finish, fallbackMs)
}
