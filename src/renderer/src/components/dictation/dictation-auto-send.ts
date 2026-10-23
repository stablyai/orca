import {
  DEFAULT_DICTATION_AUTO_SEND_DELAY_MS,
  DICTATION_AUTO_SEND_DELAYS_MS
} from '../../../../shared/constants'
import type { DictationInsertionTarget } from './dictation-insertion-target'

/** Dispatched on `document` when a countdown ends; the composer owning `element` sends. */
export const DICTATION_SUBMIT_EVENT = 'dictation:submit'

/** Dispatched on `document` to drop a pending send and keep the draft. */
export const DICTATION_CANCEL_AUTO_SEND_EVENT = 'dictation:cancelAutoSend'

/** Marks an input whose owner sends on `DICTATION_SUBMIT_EVENT`. */
export const DICTATION_AUTO_SEND_ATTRIBUTE = 'data-dictation-auto-send'

export type DictationSubmitDetail = { element: HTMLElement }

export type DictationAutoSend = { cancel: () => void }

// Why: dictation's own insertion fires `input`, so only these mean the user took over before it lands.
const USER_TAKEOVER_EVENTS = ['keydown', 'focusout', 'paste', 'drop', 'compositionstart'] as const

export function resolveDictationAutoSendDelayMs(delayMs: number | undefined): number {
  return (
    DICTATION_AUTO_SEND_DELAYS_MS.find((allowed) => allowed === delayMs) ??
    DEFAULT_DICTATION_AUTO_SEND_DELAY_MS
  )
}

/** The composer element a stopping dictation may send from, or null when it must not send. */
export function resolveDictationAutoSendElement(options: {
  enabled: boolean
  target: DictationInsertionTarget | null
}): HTMLElement | null {
  const { enabled, target } = options
  if (!enabled || !target) {
    return null
  }
  if (target.kind === 'terminal') {
    return null
  }
  const element = target.element
  if (!element.isConnected || !element.closest(`[${DICTATION_AUTO_SEND_ATTRIBUTE}]`)) {
    return null
  }
  return element
}

function isAppActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/**
 * Waits for the dictated text to land, then sends after `delayMs`, unless the user types, edits
 * or leaves `element` or the app first, delivery fails, or focus is gone by then.
 * `onCountdown` runs when the countdown starts; `onSettled` runs once, however it ends.
 */
export function armDictationAutoSend(
  element: HTMLElement,
  options: {
    delivered: Promise<boolean>
    delayMs: number
    onCountdown: (deadline: number) => void
    onSettled: () => void
  }
): DictationAutoSend {
  let settled = false
  let countingDown = false
  let timer: number | undefined
  const listenedEvents = [...USER_TAKEOVER_EVENTS, 'input'] as const

  const settle = (): void => {
    if (settled) {
      return
    }
    settled = true
    window.clearTimeout(timer)
    for (const type of listenedEvents) {
      element.removeEventListener(type, handleUserEvent, true)
    }
    window.removeEventListener('blur', handleAppLeave)
    document.removeEventListener('visibilitychange', handleAppLeave)
    options.onSettled()
  }
  // Why: switching apps can keep the editor as the active element, so no focusout fires.
  const handleAppLeave = (): void => {
    if (!isAppActive()) {
      settle()
    }
  }
  const handleUserEvent = (event: Event): void => {
    if (event.type === 'input' && !countingDown) {
      return
    }
    if (
      event instanceof FocusEvent &&
      event.relatedTarget instanceof Node &&
      element.contains(event.relatedTarget)
    ) {
      return
    }
    settle()
  }
  const startCountdown = (): void => {
    countingDown = true
    timer = window.setTimeout(() => {
      settle()
      if (element.isConnected && isAppActive()) {
        document.dispatchEvent(
          new CustomEvent<DictationSubmitDetail>(DICTATION_SUBMIT_EVENT, { detail: { element } })
        )
      }
    }, options.delayMs)
    options.onCountdown(Date.now() + options.delayMs)
  }

  for (const type of listenedEvents) {
    element.addEventListener(type, handleUserEvent, true)
  }
  window.addEventListener('blur', handleAppLeave)
  document.addEventListener('visibilitychange', handleAppLeave)
  void options.delivered.then((delivered) => {
    if (settled) {
      return
    }
    const focused = element.isConnected && element.contains(element.ownerDocument.activeElement)
    if (delivered && focused && isAppActive()) {
      startCountdown()
    } else {
      settle()
    }
  })
  return { cancel: settle }
}
