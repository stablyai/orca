import type { IDisposable } from '@xterm/xterm'

// Why: Orca's xterm patch falls back to the last non-empty compositionupdate when a session ends
// with no committed text (`textareaInput || endData || compositionData`). An IME that empties its
// preedit instead of committing — macOS Zhuyin Backspace on the last symbol — then replays the
// abandoned preedit into the PTY rather than deleting. Pristine upstream xterm sends nothing here.
//
// The discriminator deliberately avoids the compositionupdate sequence, which differs per IME
// dialect: some blank the preedit first, macOS can jump straight to compositionend. A commit
// always surfaces its text either on compositionend or on the input event that follows it.

export type TerminalImeAbandonedPreeditGuard = IDisposable & {
  /** True once per composition that ended with no committed text, so its payload is stale. */
  consume: () => boolean
}

export function installTerminalImeAbandonedPreeditGuard(
  terminalElement: HTMLElement | null | undefined
): TerminalImeAbandonedPreeditGuard {
  let endedEmpty = false
  let committedAfterEnd = false

  const consume = (): boolean => {
    const abandoned = endedEmpty && !committedAfterEnd
    endedEmpty = false
    committedAfterEnd = false
    return abandoned
  }

  if (!terminalElement || typeof terminalElement.addEventListener !== 'function') {
    return { consume, dispose: () => undefined }
  }

  const onCompositionStart = (): void => {
    endedEmpty = false
    committedAfterEnd = false
  }
  const onCompositionEnd = (event: Event): void => {
    if (event instanceof CompositionEvent) {
      endedEmpty = event.data === ''
      committedAfterEnd = false
    }
  }
  const onInput = (event: Event): void => {
    // Why: Chromium fires the commit's input event right after compositionend and before xterm's
    // deferred finalizer, so text landing here proves the session committed rather than aborted.
    if (endedEmpty && event instanceof InputEvent && (event.data?.length ?? 0) > 0) {
      committedAfterEnd = true
    }
  }

  terminalElement.addEventListener('compositionstart', onCompositionStart, true)
  terminalElement.addEventListener('compositionend', onCompositionEnd, true)
  terminalElement.addEventListener('input', onInput, true)

  return {
    consume,
    dispose: () => {
      terminalElement.removeEventListener('compositionstart', onCompositionStart, true)
      terminalElement.removeEventListener('compositionend', onCompositionEnd, true)
      terminalElement.removeEventListener('input', onInput, true)
    }
  }
}
