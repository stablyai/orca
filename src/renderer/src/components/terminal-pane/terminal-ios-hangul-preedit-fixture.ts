import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Terminal } from '@xterm/xterm'
import { isCurrentPlatformIosWeb } from '../../lib/ios-web-platform'
import { installTerminalImeCompositionTracker } from './terminal-ime-composition-tracker'
import { createTerminalIosHangulPreeditRenderer } from './terminal-ios-hangul-preedit-overlay'
import {
  installTerminalIosHangulPreedit,
  type TerminalIosHangulPreedit
} from './terminal-ios-hangul-preedit'
import {
  shouldBypassXtermKeyboardEvent,
  shouldSuppressTerminalImeKeyboardEvent
} from './xterm-bypass-policy'

/**
 * Shared rig for the iPadOS Hangul suites: a real xterm `Terminal` wired to the
 * same tracker, bypass policy and preedit controller the pane lifecycle
 * installs, so the tests exercise the whole path rather than a mock of it.
 */

export const IPAD_DESKTOP_MODE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

export type IosHangulRig = {
  compositionView: HTMLElement
  /** Every chunk the terminal handed to the PTY, in order. */
  emitted: string[]
  preedit: TerminalIosHangulPreedit
  terminal: Terminal
  textarea: HTMLTextAreaElement
}

const openTerminals: Terminal[] = []

export function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

/** iPadOS reports a Mac user agent, so the touch-point count is what separates it from a desktop. */
export function pretendIosWeb(maxTouchPoints = 5, userAgent = IPAD_DESKTOP_MODE_UA): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true })
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: maxTouchPoints,
    configurable: true
  })
}

export function disposeOpenTerminals(): void {
  for (const terminal of openTerminals.splice(0)) {
    terminal.dispose()
  }
}

export function openIosTerminal(
  options: {
    isIosWeb?: boolean
    /** Overrides the tracker, to isolate what the controller reads it for. */
    isCompositionActive?: () => boolean
    screenReaderMode?: boolean
  } = {}
): IosHangulRig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({
    cols: 40,
    rows: 8,
    screenReaderMode: options.screenReaderMode
  })
  openTerminals.push(terminal)
  terminal.open(container)
  const textarea = terminal.textarea
  const compositionView = container.querySelector<HTMLElement>('.composition-view')
  if (!textarea || !compositionView) {
    throw new Error('xterm did not create the helper textarea and composition view')
  }

  // Mirrors the lifecycle: the platform decides, so a desktop rig exercises the
  // real gate rather than a flag the test set.
  const isIosWeb = options.isIosWeb ?? isCurrentPlatformIosWeb()
  const tracker = installTerminalImeCompositionTracker(terminal.element)
  const preedit = isIosWeb
    ? installTerminalIosHangulPreedit({
        terminalElement: terminal.element,
        isCompositionActive: options.isCompositionActive ?? (() => tracker.isActive()),
        isScreenReaderMode: () => terminal.options.screenReaderMode === true,
        sendInput: (data) => terminal.input(data),
        renderPreedit: createTerminalIosHangulPreeditRenderer(terminal)
      })
    : { heldText: () => '', dispose: () => undefined }

  terminal.attachCustomKeyEventHandler((event) => {
    if (
      shouldSuppressTerminalImeKeyboardEvent(event, {
        compositionActive: tracker.isActive(),
        candidateKeyGuardActive: tracker.isCandidateKeyGuardActive(),
        pendingCandidateKeyReleaseActive: false,
        hangulPreedit: tracker.isHangulPreedit(),
        isMac: true,
        isLinux: false
      })
    ) {
      return false
    }
    return !shouldBypassXtermKeyboardEvent(event, {
      isMac: true,
      isIosWeb,
      hasSelection: false
    })
  })

  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { compositionView, emitted, preedit, terminal, textarea }
}

export function dispatchKey(
  { textarea }: IosHangulRig,
  type: 'keydown' | 'keypress' | 'keyup',
  init: {
    key: string
    code?: string
    keyCode?: number
    charCode?: number
    shiftKey?: boolean
    isComposing?: boolean
  }
): boolean {
  const event = new KeyboardEvent(type, {
    key: init.key,
    code: init.code ?? 'KeyQ',
    shiftKey: init.shiftKey ?? false,
    bubbles: true,
    cancelable: true
  })
  // happy-dom drops the legacy numeric fields from KeyboardEventInit; xterm's key paths read them.
  Object.defineProperty(event, 'keyCode', { value: init.keyCode ?? init.key.charCodeAt(0) })
  Object.defineProperty(event, 'charCode', { value: init.charCode ?? 0 })
  Object.defineProperty(event, 'isComposing', { value: init.isComposing ?? false })
  textarea.dispatchEvent(event)
  return event.defaultPrevented
}

export function dispatchInput(
  { textarea }: IosHangulRig,
  inputType: string,
  data: string | null,
  init: { isComposing?: boolean } = {}
): void {
  const event = new InputEvent('input', { bubbles: true })
  Object.defineProperty(event, 'inputType', { value: inputType })
  Object.defineProperty(event, 'data', { value: data })
  Object.defineProperty(event, 'isComposing', { value: init.isComposing ?? false })
  // Trusted user events are always composed; that is the flag that makes xterm drop the commit.
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

export function dispatchComposition(
  { textarea }: IosHangulRig,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data?: string
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  if (data !== undefined) {
    Object.defineProperty(event, 'data', { value: data })
  }
  textarea.dispatchEvent(event)
}

/**
 * One printable keystroke as a browser produces it: the key, then — only if
 * xterm did not consume the keydown — the keypress and the text the IME writes.
 */
export async function typePrintable(
  rig: IosHangulRig,
  {
    key,
    keyCode,
    written,
    replaces,
    shiftKey
  }: {
    key: string
    keyCode: number
    written: string
    replaces: boolean
    shiftKey?: boolean
  }
): Promise<void> {
  if (dispatchKey(rig, 'keydown', { key, keyCode, shiftKey })) {
    await nextEventLoop()
    return
  }
  dispatchKey(rig, 'keypress', { key, keyCode, charCode: key.charCodeAt(0), shiftKey })
  if (replaces) {
    rig.textarea.value = rig.textarea.value.slice(0, -1)
    dispatchInput(rig, 'deleteContentBackward', null)
  }
  rig.textarea.value += written
  dispatchInput(rig, 'insertText', written)
  await nextEventLoop()
}

/**
 * A jamo keystroke. `replaces` is the delete-then-insert the IME uses while a
 * syllable is still growing; without it the syllable is finished and the jamo
 * simply appends.
 */
export function typeJamo(
  rig: IosHangulRig,
  key: string,
  written: string,
  options: { replaces: boolean; shiftKey?: boolean }
): Promise<void> {
  return typePrintable(rig, {
    key,
    keyCode: key.charCodeAt(0),
    written,
    replaces: options.replaces,
    shiftKey: options.shiftKey
  })
}

/** `한글`, keystroke for keystroke, as captured from the iPad. */
export async function typeHangeul(rig: IosHangulRig): Promise<void> {
  await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
  await typeJamo(rig, 'ㅏ', '하', { replaces: true })
  await typeJamo(rig, 'ㄴ', '한', { replaces: true })
  await typeJamo(rig, 'ㄱ', 'ㄱ', { replaces: false })
  await typeJamo(rig, 'ㅡ', '그', { replaces: true })
  await typeJamo(rig, 'ㄹ', '글', { replaces: true })
}

/** One DOM event exactly as the on-device recorder saw it. */
export type IosDeviceTraceEvent = {
  type: 'keydown' | 'input'
  key: string
  keyCode: number | null
  inputType: string | null
  data: string
  /** `textarea.value` at the moment the event fired. */
  value: string
}

export type IosDeviceTrace = {
  source: string
  userAgent: string
  maxTouchPoints: number
  typed: string
  expected: string
  /** What the device build actually put on the wire, bug included. */
  observedSent: string[]
  events: IosDeviceTraceEvent[]
}

export function loadIosDeviceTrace(fileName: string): IosDeviceTrace {
  const path = resolve(
    process.cwd(),
    'src/renderer/src/components/terminal-pane/__fixtures__',
    fileName
  )
  return JSON.parse(readFileSync(path, 'utf8')) as IosDeviceTrace
}

/** A recorded keydown whose field value no longer matches on replay. */
export type FieldDrift = { index: number; recorded: string; actual: string }

/**
 * Replays a capture verbatim — the recorded events only, with the field set to
 * the value the device held at each one. No keypress: the recorder captured
 * keydown and input, so the browser's keypress is not replayed here and the
 * hand-driven suites keep that coverage.
 *
 * Returns every keydown at which the field had drifted from the recording,
 * which is how the controller having disturbed the IME's own state shows up.
 */
export async function replayIosDeviceTrace(
  rig: IosHangulRig,
  trace: IosDeviceTrace
): Promise<FieldDrift[]> {
  const drift: FieldDrift[] = []
  for (const [index, event] of trace.events.entries()) {
    if (event.type === 'keydown') {
      if (rig.textarea.value !== event.value) {
        drift.push({ index, recorded: event.value, actual: rig.textarea.value })
      }
      dispatchKey(rig, 'keydown', { key: event.key, keyCode: event.keyCode ?? 0 })
    } else {
      rig.textarea.value = event.value
      dispatchInput(rig, event.inputType ?? 'insertText', event.data || null)
    }
    await nextEventLoop()
  }
  return drift
}

/**
 * The same capture as keystrokes, so the shared `typeJamo` path replays it with
 * the keypress a browser fires. `replaces` is read off the recording: a jamo
 * that first attaches to the previous syllable arrives as delete-then-insert.
 */
export type DeviceTraceKeystroke = {
  key: string
  keyCode: number
  written: string
  replaces: boolean
  shiftKey: boolean
}

export function deviceTraceKeystrokes(trace: IosDeviceTrace): DeviceTraceKeystroke[] {
  const steps: DeviceTraceKeystroke[] = []
  let shiftKey = false
  for (const event of trace.events) {
    if (event.type === 'keydown') {
      if (event.key === 'Shift') {
        shiftKey = true
        continue
      }
      steps.push({
        key: event.key,
        keyCode: event.keyCode ?? 0,
        written: '',
        replaces: false,
        shiftKey
      })
      shiftKey = false
      continue
    }
    const step = steps.at(-1)
    if (!step) {
      throw new Error('trace opens with an input event, which no keystroke owns')
    }
    if (event.inputType?.startsWith('delete')) {
      step.replaces = true
    } else {
      step.written = event.data
    }
  }
  return steps
}
