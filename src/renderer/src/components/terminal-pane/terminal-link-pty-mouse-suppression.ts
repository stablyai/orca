import type { IDisposable, Terminal } from '@xterm/xterm'
import {
  isTerminalLinkActionActivation,
  isTerminalLinkDirectActivation
} from './terminal-link-activation'

const CAPTURE_LISTENER_OPTIONS = { capture: true } as const
const MAX_DEFERRED_PTY_INPUT_FRAMES = 64

type DeferredPtyInput = {
  data: string
  forward: (data: string) => void
}

export type TerminalLinkPtyMouseSuppression = IDisposable & {
  claimAction: () => boolean
  handlePtyInput: (data: string, forward: (data: string) => void) => void
}

function isXtermMouseReport(data: string): boolean {
  return (
    (data.startsWith('\x1b[M') && data.length === 6) ||
    (data.startsWith('\x1b[<') && /^\d+;\d+;\d+[Mm]$/.test(data.slice(3)))
  )
}

export function installTerminalLinkPtyMouseSuppression(
  terminal: Terminal,
  shouldSuppressMouseEvent: (event: MouseEvent) => boolean,
  shouldDeferPlainMouseEvent: (event: MouseEvent) => boolean = () => false,
  shouldContinueDeferring: (event: MouseEvent) => boolean = () => true
): TerminalLinkPtyMouseSuppression {
  const terminalElement = terminal.element
  const ownerDocument = terminalElement?.ownerDocument
  const ownerWindow = ownerDocument?.defaultView
  let previousMouseEventsRequireAlt: boolean | null = null
  let restoreQueued = false
  let deferredPtyInput: DeferredPtyInput[] | null = null
  let capturesPtyInput = false
  let actionClaimed = false
  let deferredInputFallbackTimer: number | null = null
  let deferredListenersInstalled = false

  const restore = (): void => {
    restoreQueued = false
    if (previousMouseEventsRequireAlt === null) {
      return
    }
    terminal.options.mouseEventsRequireAlt = previousMouseEventsRequireAlt
    previousMouseEventsRequireAlt = null
    ownerDocument?.removeEventListener('mouseup', queueRestore)
    ownerWindow?.removeEventListener('blur', restore)
  }
  const queueRestore = (): void => {
    if (restoreQueued || previousMouseEventsRequireAlt === null) {
      return
    }
    restoreQueued = true
    queueMicrotask(restore)
  }
  const finishDeferredInput = (): void => {
    if (deferredInputFallbackTimer !== null) {
      ownerWindow?.clearTimeout(deferredInputFallbackTimer)
      deferredInputFallbackTimer = null
    }
    const deferred = deferredPtyInput
    const shouldForward = deferred !== null && !actionClaimed
    deferredPtyInput = null
    capturesPtyInput = false
    actionClaimed = false
    removeDeferredListeners()
    if (shouldForward) {
      for (const input of deferred) {
        input.forward(input.data)
      }
    }
  }
  const captureCurrentMouseEvent = (): void => {
    capturesPtyInput = true
  }
  const handleMouseDown = (event: MouseEvent): void => {
    if (isTerminalLinkActionActivation(event) && shouldDeferPlainMouseEvent(event)) {
      finishDeferredInput()
      deferredPtyInput = []
      addDeferredListeners()
      captureCurrentMouseEvent()
      return
    }
    if (!isTerminalLinkDirectActivation(event) || !shouldSuppressMouseEvent(event)) {
      return
    }
    restore()
    previousMouseEventsRequireAlt = Boolean(terminal.options.mouseEventsRequireAlt)
    // Why: an Orca-owned link gesture must not also reach a mouse-aware child TUI.
    terminal.options.mouseEventsRequireAlt = true
    ownerDocument?.addEventListener('mouseup', queueRestore)
    ownerWindow?.addEventListener('blur', restore)
  }
  const handleDeferredMouseEvent = (): void => {
    if (deferredPtyInput !== null) {
      captureCurrentMouseEvent()
    }
  }
  const releaseIneligibleDrag = (event: MouseEvent): void => {
    if (deferredPtyInput !== null && !shouldContinueDeferring(event)) {
      finishDeferredInput()
    }
  }
  const releaseCurrentMouseEvent = (): void => {
    capturesPtyInput = false
  }
  const queueDeferredInputFallback = (): void => {
    if (deferredPtyInput !== null) {
      if (deferredInputFallbackTimer !== null) {
        ownerWindow?.clearTimeout(deferredInputFallbackTimer)
      }
      deferredInputFallbackTimer = ownerWindow?.setTimeout(finishDeferredInput, 0) ?? null
    }
  }
  const handleBlur = (): void => {
    finishDeferredInput()
    restore()
  }
  const addDeferredListeners = (): void => {
    if (deferredListenersInstalled) {
      return
    }
    deferredListenersInstalled = true
    ownerDocument?.addEventListener('mousemove', handleDeferredMouseEvent, CAPTURE_LISTENER_OPTIONS)
    ownerDocument?.addEventListener('mousemove', releaseIneligibleDrag)
    ownerDocument?.addEventListener('mouseup', handleDeferredMouseEvent, CAPTURE_LISTENER_OPTIONS)
    ownerDocument?.addEventListener('mouseleave', finishDeferredInput)
    ownerWindow?.addEventListener('mousedown', releaseCurrentMouseEvent)
    ownerWindow?.addEventListener('mousemove', releaseCurrentMouseEvent)
    ownerWindow?.addEventListener('mouseup', releaseCurrentMouseEvent)
    ownerWindow?.addEventListener('mouseup', queueDeferredInputFallback)
    ownerWindow?.addEventListener('click', queueDeferredInputFallback)
    ownerWindow?.addEventListener('blur', handleBlur)
  }
  const removeDeferredListeners = (): void => {
    if (!deferredListenersInstalled) {
      return
    }
    deferredListenersInstalled = false
    ownerDocument?.removeEventListener(
      'mousemove',
      handleDeferredMouseEvent,
      CAPTURE_LISTENER_OPTIONS
    )
    ownerDocument?.removeEventListener('mousemove', releaseIneligibleDrag)
    ownerDocument?.removeEventListener(
      'mouseup',
      handleDeferredMouseEvent,
      CAPTURE_LISTENER_OPTIONS
    )
    ownerDocument?.removeEventListener('mouseleave', finishDeferredInput)
    ownerWindow?.removeEventListener('mousedown', releaseCurrentMouseEvent)
    ownerWindow?.removeEventListener('mousemove', releaseCurrentMouseEvent)
    ownerWindow?.removeEventListener('mouseup', releaseCurrentMouseEvent)
    ownerWindow?.removeEventListener('mouseup', queueDeferredInputFallback)
    ownerWindow?.removeEventListener('click', queueDeferredInputFallback)
    ownerWindow?.removeEventListener('blur', handleBlur)
  }

  terminalElement?.addEventListener('mousedown', handleMouseDown, CAPTURE_LISTENER_OPTIONS)
  terminalElement?.addEventListener('mouseup', queueRestore, CAPTURE_LISTENER_OPTIONS)
  return {
    claimAction: () => {
      if (deferredPtyInput === null) {
        return false
      }
      actionClaimed = true
      return true
    },
    handlePtyInput: (data, forward) => {
      if (deferredPtyInput !== null && capturesPtyInput && isXtermMouseReport(data)) {
        if (deferredPtyInput.length >= MAX_DEFERRED_PTY_INPUT_FRAMES) {
          finishDeferredInput()
          forward(data)
          return
        }
        deferredPtyInput.push({ data, forward })
        return
      }
      forward(data)
    },
    dispose: () => {
      finishDeferredInput()
      restore()
      terminalElement?.removeEventListener('mousedown', handleMouseDown, CAPTURE_LISTENER_OPTIONS)
      terminalElement?.removeEventListener('mouseup', queueRestore, CAPTURE_LISTENER_OPTIONS)
    }
  }
}
