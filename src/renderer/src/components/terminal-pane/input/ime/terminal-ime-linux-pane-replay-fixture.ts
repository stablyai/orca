import { Terminal, type IDisposable } from '@xterm/xterm'
import { afterEach, beforeEach, vi } from 'vitest'

import { installTerminalPaneInputHandling } from '../terminal-pane-pane-input'
import { TerminalKittyKeyboardModeTracker } from '../../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'

const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Orca Chrome/146.0.0.0 Electron/43.7.5 Safari/537.36'

/** One DOM event as recorded off the terminal's helper textarea. */
export type RecordedDomEvent = {
  type: string
  key?: string
  code?: string
  keyCode?: number
  charCode?: number
  shiftKey?: boolean
  isComposing?: boolean
  inputType?: string
  data?: string
  value?: string
}

export type LinuxPaneReplaySession = {
  emit: (recorded: RecordedDomEvent) => boolean
  emitted: () => string
  dispose: () => void
}

export type LinuxPaneReplayResult = {
  emitted: string
  /** `code` of every keydown the pane cancelled, in order. */
  preventedKeydownCodes: string[]
}

const disposables: IDisposable[] = []

/** Pins a desktop Linux UA, stubs the canvas xterm measures with, and tears panes down. */
export function useLinuxPaneTestEnvironment(): void {
  let originalUserAgent: PropertyDescriptor | undefined

  beforeEach(() => {
    originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: LINUX_UA })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm only calls measureText while measuring cells in happy-dom.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    for (const disposable of disposables.splice(0)) {
      disposable.dispose()
    }
    if (originalUserAgent) {
      Object.defineProperty(navigator, 'userAgent', originalUserAgent)
    } else {
      Reflect.deleteProperty(navigator, 'userAgent')
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

export function buildRecordedDomEvent(recorded: RecordedDomEvent): Event {
  if (recorded.type === 'keydown' || recorded.type === 'keyup' || recorded.type === 'keypress') {
    const keyboard = new KeyboardEvent(recorded.type, {
      key: recorded.key,
      code: recorded.code,
      shiftKey: recorded.shiftKey,
      isComposing: recorded.isComposing,
      bubbles: true,
      cancelable: true
    })
    // happy-dom drops the legacy numeric fields from KeyboardEventInit; xterm reads them.
    Object.defineProperty(keyboard, 'keyCode', { value: recorded.keyCode ?? 0 })
    Object.defineProperty(keyboard, 'charCode', { value: recorded.charCode ?? 0 })
    Object.defineProperty(keyboard, 'which', { value: recorded.charCode || recorded.keyCode || 0 })
    return keyboard
  }
  if (recorded.type === 'input' || recorded.type === 'beforeinput') {
    const input = new InputEvent(recorded.type, {
      isComposing: recorded.isComposing,
      bubbles: true,
      cancelable: recorded.type === 'beforeinput'
    })
    Object.defineProperty(input, 'inputType', { value: recorded.inputType ?? '' })
    Object.defineProperty(input, 'data', { value: recorded.data ?? null })
    Object.defineProperty(input, 'composed', { value: true })
    return input
  }
  if (recorded.type === 'blur' || recorded.type === 'focus') {
    return new FocusEvent(recorded.type, { bubbles: false })
  }
  const composition = new CompositionEvent(recorded.type, { bubbles: true })
  Object.defineProperty(composition, 'data', { value: recorded.data ?? '' })
  return composition
}

/**
 * Opens a real xterm wired with the pane's full keyboard stack for synchronous or async DOM event dispatch.
 * `kittyPush` is written as PTY output first, the way a TUI negotiates the protocol.
 */
export async function openLinuxPaneReplaySession(
  kittyPush: string | null = null
): Promise<LinuxPaneReplaySession> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  // Matches the pane defaults that advertise kitty support (pane-terminal-options.ts).
  const terminal = new Terminal({ cols: 40, rows: 8, vtExtensions: { kittyKeyboard: true } })
  const imeCompositionDisposables = new Map<number, IDisposable>()
  const imeNativeTextForwarderDisposables = new Map<number, IDisposable>()
  const disposeImeHandlers = (): void => {
    for (const disposable of imeCompositionDisposables.values()) {
      disposable.dispose()
    }
    imeCompositionDisposables.clear()
    for (const disposable of imeNativeTextForwarderDisposables.values()) {
      disposable.dispose()
    }
    imeNativeTextForwarderDisposables.clear()
  }
  disposables.push(terminal, { dispose: disposeImeHandlers })
  terminal.open(container)
  const kittyModes = new TerminalKittyKeyboardModeTracker()
  installTerminalPaneInputHandling({
    pane: { id: 1, terminal },
    managerRef: { current: null },
    paneKittyKeyboardModesRef: { current: new Map([[1, kittyModes]]) },
    settingsRef: { current: {} },
    imeCompositionDisposablesRef: { current: imeCompositionDisposables },
    imeNativeTextForwarderDisposablesRef: { current: imeNativeTextForwarderDisposables }
  })
  if (kittyPush) {
    kittyModes.scan(kittyPush)
    await new Promise<void>((resolve) => terminal.write(kittyPush, resolve))
  }
  const emitted: string[] = []
  disposables.push(terminal.onData((data) => emitted.push(data)))
  const textarea = terminal.textarea!
  return {
    emit: (recorded: RecordedDomEvent): boolean => {
      if (recorded.value !== undefined) {
        textarea.value = recorded.value
        textarea.setSelectionRange(recorded.value.length, recorded.value.length)
      }
      const dispatched = buildRecordedDomEvent(recorded)
      textarea.dispatchEvent(dispatched)
      return dispatched.defaultPrevented
    },
    emitted: () => emitted.join(''),
    dispose: disposeImeHandlers
  }
}

/**
 * Replays recorded events through a real xterm wired with the pane's full keyboard stack.
 * `kittyPush` is written as PTY output first, the way a TUI negotiates the protocol.
 */
export async function replayThroughLinuxPane(
  events: readonly RecordedDomEvent[],
  kittyPush: string | null = null
): Promise<LinuxPaneReplayResult> {
  const session = await openLinuxPaneReplaySession(kittyPush)
  const preventedKeydownCodes: string[] = []
  let keystrokeCancelled = false
  for (const recorded of events) {
    if (recorded.type === 'keydown' || recorded.type === 'keyup') {
      await nextEventLoop()
    }
    // Why: Chromium skips a keydown's keypress and text insertion once it is preventDefault-ed.
    if (
      keystrokeCancelled &&
      (recorded.type === 'keypress' || recorded.type === 'beforeinput' || recorded.type === 'input')
    ) {
      continue
    }
    const defaultPrevented = session.emit(recorded)
    if (recorded.type === 'keydown') {
      keystrokeCancelled = defaultPrevented
      if (defaultPrevented) {
        preventedKeydownCodes.push(recorded.code ?? '')
      }
    } else if (recorded.type === 'keyup') {
      keystrokeCancelled = false
    }
  }
  await nextEventLoop()
  await nextEventLoop()
  return { emitted: session.emitted(), preventedKeydownCodes }
}
