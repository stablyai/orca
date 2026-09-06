import {
  readTerminalImeCompositionSessionDetail,
  XTERM_COMPOSITION_SESSION_END_EVENT
} from '@/components/terminal-pane/terminal-ime-composition-route'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'

export type TypingInputSource = 'direct' | 'ime'

export type TypingInputSignal = {
  source: TypingInputSource
  text: string
  event: Event
}

type InputEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

export type TypingInputRegistration = {
  settleAfterPropagation: (defaultPrevented: boolean) => void
}

function isDirectEchoInput(event: KeyboardEvent): boolean {
  if (isImeOwnedKeyboardEvent(event) || event.key === 'Process') {
    return false
  }
  return event.key.length === 1 || event.key === 'Enter' || event.key === 'Backspace'
}

/** Watches inputs that actually dispatch terminal data, not the IME's preedit keystrokes. */
export function installTypingLatencyInputEvents(
  target: InputEventTarget,
  onInput: (signal: TypingInputSignal) => TypingInputRegistration | void
): () => void {
  const pendingCompositionInputs = new WeakMap<Event, TypingInputRegistration>()
  const onKeydown = (event: Event): void => {
    if (event instanceof KeyboardEvent && isDirectEchoInput(event)) {
      onInput({ source: 'direct', text: event.key, event })
    }
  }
  const onCompositionSessionEnd = (event: Event): void => {
    const detail = readTerminalImeCompositionSessionDetail(event)
    if (!detail?.data || detail.dataPendingReconciliation) {
      return
    }
    const registration = onInput({ source: 'ime', text: detail.data, event })
    if (registration) {
      pendingCompositionInputs.set(event, registration)
    }
  }
  const settleCompositionSessionEnd = (event: Event): void => {
    const registration = pendingCompositionInputs.get(event)
    pendingCompositionInputs.delete(event)
    registration?.settleAfterPropagation(event.defaultPrevented)
  }

  target.addEventListener('keydown', onKeydown, { capture: true })
  target.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onCompositionSessionEnd, {
    capture: true
  })
  target.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, settleCompositionSessionEnd)
  return () => {
    target.removeEventListener('keydown', onKeydown, { capture: true })
    target.removeEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onCompositionSessionEnd, {
      capture: true
    })
    target.removeEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, settleCompositionSessionEnd)
  }
}
