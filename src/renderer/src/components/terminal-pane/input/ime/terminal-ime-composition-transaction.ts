import {
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT,
  readTerminalImeCompositionSessionDetail
} from './terminal-ime-composition-route'

const XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT = 'xterm-composition-transaction-accepted'
const XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT = 'xterm-composition-transaction-settled'

export type TerminalImeCompositionTransaction = {
  /** True from xterm accepting a composition until its finalizer settles it; xterm owns commits meanwhile. */
  isPending: () => boolean
  /** Sends a commit that landed after its composition settled; returns true when it consumed the event. */
  claimLateCommit: (event: InputEvent) => boolean
  dispose: () => void
}

/**
 * Async IBus Hangul (IBUS_ENABLE_SYNC_MODE=0) clears the preedit, ends the composition empty, and only
 * then commits the syllable as a bare insertText (#42246). Once xterm's finalizer has settled, or its
 * preedit resync cancelled the emptied session, xterm drops that insertText while the ending key is
 * still held, so the syllable never reaches the PTY.
 */
export function installTerminalImeCompositionTransaction(args: {
  terminalElement: HTMLElement
  sendInput: (data: string) => void
}): TerminalImeCompositionTransaction {
  let pending = false
  // xterm can defer an unobserved compositionend and still finalize this session later.
  let openXtermSessionId: number | null = null
  let composing = false
  let startValue = ''
  let preedit = ''
  // Backspace or xterm's own Escape cancel drops the preedit; ibus-hangul's Esc flushes it as Process.
  let endedByCancelKey = false
  let awaitingLateCommit = false

  const textareaValue = (event: Event): string | null =>
    event.target instanceof HTMLTextAreaElement ? event.target.value : null

  const onAccepted = (): void => {
    pending = true
  }
  const onSettled = (): void => {
    pending = false
  }
  const onSessionStart = (event: Event): void => {
    openXtermSessionId = readTerminalImeCompositionSessionDetail(event)?.id ?? null
  }
  // A previous transaction's pending finalizer can end its session after the next one started.
  const onSessionEnd = (event: Event): void => {
    if (readTerminalImeCompositionSessionDetail(event)?.id === openXtermSessionId) {
      openXtermSessionId = null
    }
  }
  const onCompositionStart = (event: Event): void => {
    composing = true
    startValue = textareaValue(event) ?? ''
    preedit = ''
    endedByCancelKey = false
    awaitingLateCommit = false
  }
  const onCompositionUpdate = (event: Event): void => {
    if (composing && event instanceof CompositionEvent && event.data) {
      preedit = event.data
    }
  }
  const onCompositionEnd = (event: Event): void => {
    const endData = event instanceof CompositionEvent ? event.data : ''
    // The preedit left the field without committing anything, so its text is still owed.
    awaitingLateCommit =
      composing &&
      !endedByCancelKey &&
      !endData &&
      preedit.length > 0 &&
      textareaValue(event) === startValue
    composing = false
  }
  // IBus answers keys in order, so a later key normally means no commit is owed. When fast typing lands
  // the commit after that key, the forwarder's pendingCommit and xterm's _claimImeKeydownCommit take it, as before.
  const onKeydown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) {
      return
    }
    if (composing) {
      endedByCancelKey =
        event.key === 'Backspace' || event.code === 'Backspace' || event.key === 'Escape'
    } else {
      awaitingLateCommit = false
    }
  }
  const reset = (): void => {
    pending = false
    openXtermSessionId = null
    composing = false
    awaitingLateCommit = false
  }

  const claimLateCommit = (event: InputEvent): boolean => {
    if (!awaitingLateCommit || event.inputType !== 'insertText') {
      return false
    }
    awaitingLateCommit = false
    // Until xterm settles or ends the session, its own post-composition input path sends it.
    if (!event.data || pending || openXtermSessionId !== null) {
      return false
    }
    args.sendInput(event.data)
    event.stopImmediatePropagation()
    return true
  }

  const listeners: readonly (readonly [string, (event: Event) => void])[] = [
    [XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT, onAccepted],
    [XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT, onSettled],
    [XTERM_COMPOSITION_SESSION_START_EVENT, onSessionStart],
    [XTERM_COMPOSITION_SESSION_END_EVENT, onSessionEnd],
    ['compositionstart', onCompositionStart],
    ['compositionupdate', onCompositionUpdate],
    ['compositionend', onCompositionEnd],
    ['keydown', onKeydown],
    ['blur', reset]
  ]
  const { terminalElement } = args
  for (const [type, listener] of listeners) {
    terminalElement.addEventListener(type, listener, true)
  }

  return {
    isPending: () => pending,
    claimLateCommit,
    dispose: () => {
      reset()
      for (const [type, listener] of listeners) {
        terminalElement.removeEventListener(type, listener, true)
      }
    }
  }
}
