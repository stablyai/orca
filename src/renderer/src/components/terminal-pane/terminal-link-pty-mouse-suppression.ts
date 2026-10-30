import { createTerminalLinkPointerListeners } from './terminal-link-pointer-listeners'
import {
  sameNativeMouseEvent,
  forwardTerminalLinkFrames,
  type InputBinding,
  type Transaction,
  type TerminalLinkPtyMouseSuppression
} from './terminal-link-input-transaction'
import type { Terminal } from '@xterm/xterm'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isTerminalLinkDirectActivation } from './terminal-link-activation'
import { isXtermMouseReport } from './terminal-pointer-input-sequences'

const CAPTURE = { capture: true } as const
const MAX_DEFERRED_PTY_INPUT_FRAMES = 64

export type { TerminalLinkPtyMouseSuppression } from './terminal-link-input-transaction'

/** One reversible transaction; a forwarded press can never acquire application ownership later. */
export function installTerminalLinkPtyMouseSuppression(
  terminal: Pick<Terminal, 'element' | 'clearSelection'>,
  options: {
    candidate: (event: MouseEvent) => string | null
    eligible: (event: MouseEvent) => boolean
    canContinue: (event: MouseEvent) => boolean
  }
): TerminalLinkPtyMouseSuppression {
  const element = terminal.element
  const document = element?.ownerDocument
  const window = document?.defaultView
  const platform = getShortcutPlatform()
  let source: InputBinding | null = null
  let transaction: Transaction | null = null
  let keyboard: { source: InputBinding; event: KeyboardEvent } | null = null
  let timer: number | null = null
  let closed = false
  let applyingOperation = false
  const clearTimer = (): void => {
    if (timer !== null) {
      window?.clearTimeout(timer)
      timer = null
    }
  }
  const pointerListeners = createTerminalLinkPointerListeners(document, window, {
    replacePress,
    captureMove,
    captureUp,
    checkDrag,
    invalidate
  })
  const settle = (keepTail: boolean): void => {
    const previous = transaction
    if (!previous) {
      return
    }
    const frames = previous.state === 'pending' ? previous.frames : null
    previous.frames = null
    previous.state =
      previous.state === 'pending' || previous.state === 'revoked-forward'
        ? 'revoked-forward'
        : 'revoked-consumed'
    if (keepTail && !closed) {
      pointerListeners.install(true)
    } else {
      transaction = null
      pointerListeners.remove()
    }
    forwardTerminalLinkFrames(frames)
  }
  const scheduleSettlement = (): void => {
    if (timer !== null || !window) {
      return
    }
    const pending = transaction
    const origin = keyboard
    timer = window.setTimeout(() => {
      timer = null
      if (keyboard === origin) {
        keyboard = null
      }
      if (transaction === pending && pending?.up) {
        settle(false)
      }
    }, 0)
  }
  function invalidate(): void {
    keyboard = null
    settle(true)
  }
  function replacePress(): void {
    clearTimer()
    keyboard = null
    settle(false)
  }
  function captureMove(event: MouseEvent): void {
    const pending = transaction
    if (!pending) {
      return
    }
    if (event.buttons === 0) {
      settle(false)
      return
    }
    pending.dispatch = event
  }
  function checkDrag(event: MouseEvent): void {
    if (
      transaction?.state === 'pending' &&
      !transaction.direct &&
      transaction.down.button === 0 &&
      !(platform === 'darwin' && transaction.down.ctrlKey) &&
      !options.canContinue(event)
    ) {
      settle(true)
    }
  }
  function captureUp(event: MouseEvent): void {
    if (!transaction || transaction.down.button !== event.button) {
      return
    }
    transaction.up = event
    transaction.dispatch = event
    scheduleSettlement()
  }
  const captureDown = (event: MouseEvent): void => {
    replacePress()
    if (closed || !source?.isCurrent() || !options.eligible(event)) {
      return
    }
    const candidate = options.candidate(event)
    if (candidate === null) {
      return
    }
    transaction = {
      source,
      candidate,
      down: event,
      up: null,
      dispatch: event,
      direct: isTerminalLinkDirectActivation(event),
      state: 'pending',
      frames: []
    }
    pointerListeners.install(false)
  }
  const apply = (event: MouseEvent, operation: () => void): void => {
    applyingOperation = true
    try {
      event.preventDefault()
      terminal.clearSelection()
      operation()
    } finally {
      applyingOperation = false
    }
  }
  element?.addEventListener('mousedown', captureDown, CAPTURE)
  element?.addEventListener('mouseup', captureUp, CAPTURE)
  const binding: TerminalLinkPtyMouseSuppression = {
    commit: (event, operation) => {
      if (event.type === 'contextmenu' && event.button === -1) {
        return binding.commitKeyboard(event, operation.run)
      }
      const candidate = options.candidate(event)
      return candidate !== null && binding.commitPointer(event, candidate, operation.run)
    },
    bindSource: (next) => {
      if (next !== source) {
        source = next
        invalidate()
      }
    },
    invalidateSource: invalidate,
    reset: invalidate,
    recordKeyEvent: (event) => {
      const menu =
        event.key === 'ContextMenu' && event.type === (platform === 'win32' ? 'keyup' : 'keydown')
      const f10 =
        platform !== 'darwin' && event.type === 'keydown' && event.key === 'F10' && event.shiftKey
      if (!closed && source?.isCurrent() && (menu || f10)) {
        invalidate()
        keyboard = { source, event }
        scheduleSettlement()
      }
    },
    commitKeyboard: (event, operation) => {
      if (
        closed ||
        event.type !== 'contextmenu' ||
        event.button !== -1 ||
        event.buttons !== 0 ||
        !keyboard ||
        keyboard.source !== source ||
        !keyboard.source.isCurrent()
      ) {
        return false
      }
      keyboard = null
      clearTimer()
      apply(event, operation)
      return true
    },
    commitPointer: (event, candidate, operation) => {
      const pending = transaction
      if (pending?.state === 'consumed' && event.type === 'contextmenu') {
        const origin = platform === 'win32' ? pending.up : pending.down
        if (candidate === pending.candidate && origin && sameNativeMouseEvent(origin, event)) {
          event.preventDefault()
          return true
        }
      }
      if (
        closed ||
        !pending ||
        pending.state !== 'pending' ||
        pending.source !== source ||
        !pending.source.isCurrent() ||
        candidate !== pending.candidate
      ) {
        return false
      }
      const origin = platform === 'win32' ? pending.up : pending.down
      const context = event.type === 'contextmenu'
      if (
        context
          ? !origin || !sameNativeMouseEvent(origin, event)
          : pending.dispatch !== event || (platform === 'darwin' && pending.down.ctrlKey)
      ) {
        return false
      }
      if (!context && !pending.direct && !options.canContinue(event)) {
        settle(true)
        return false
      }
      pending.state = 'consumed'
      pending.frames = null
      pointerListeners.install(true)
      apply(event, operation)
      return true
    },
    handlePtyInput: (data, forward, userInput = false, qualify) => {
      const pending = transaction
      // eventPhase survives mid-dispatch microtasks; application reentry is not an xterm report.
      if (
        !pending ||
        applyingOperation ||
        pending.dispatch.eventPhase === 0 ||
        !isXtermMouseReport(data)
      ) {
        if (!qualify || qualify(data, userInput)) {
          forward(data)
        }
        return
      }
      if (pending.state === 'consumed' || pending.state === 'revoked-consumed') {
        return
      }
      if (!pending.source.isCurrent() || pending.source.qualify?.(data, userInput) === false) {
        return
      }
      const originalForward = userInput ? pending.source.user : pending.source.unclassified
      if (pending.state === 'revoked-forward') {
        originalForward(data)
        return
      }
      if ((pending.frames?.length ?? 0) === MAX_DEFERRED_PTY_INPUT_FRAMES) {
        settle(true)
        originalForward(data)
        return
      }
      pending.frames?.push({ data, forward: originalForward })
    },
    dispose: () => {
      if (closed) {
        return
      }
      closed = true
      source = null
      keyboard = null
      clearTimer()
      element?.removeEventListener('mousedown', captureDown, CAPTURE)
      element?.removeEventListener('mouseup', captureUp, CAPTURE)
      const consumedDispatch =
        transaction &&
        (transaction.state === 'consumed' || transaction.state === 'revoked-consumed') &&
        transaction.dispatch.eventPhase !== 0
          ? transaction
          : null
      try {
        settle(false)
      } finally {
        transaction = consumedDispatch
        pointerListeners.remove()
      }
    }
  }
  return binding
}
