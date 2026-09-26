// @vitest-environment happy-dom
// IME and Hangul commits bypass xterm's key path and enter through `terminal.input`. Main records
// a run's first user input from xterm's user-input signal, so every commit route must carry it.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IDisposable } from '@xterm/xterm'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import {
  installTerminalImeCompositionRoute,
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'
import { IPAD_DESKTOP_MODE_UA, pretendIosWeb } from './terminal-ios-hangul-preedit-fixture'
import { installTerminalPaneInputHandling } from './terminal-pane-pane-input'
import { subscribeToTerminalInputData } from './terminal-user-input-signal'

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

type ForwardedInput = { data: string; wasUserInput: boolean }

const disposables: IDisposable[] = []

function openPane(): {
  terminal: Terminal
  textarea: HTMLTextAreaElement
  forwarded: ForwardedInput[]
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 40, rows: 8 })
  disposables.push(terminal)
  terminal.open(container)
  const pane = { id: 1, terminal }
  installTerminalPaneInputHandling({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: input handling reads only the pane id and its terminal.
    pane: pane as unknown as ManagedPane,
    managerRef: { current: null },
    paneKittyKeyboardModesRef: { current: new Map() },
    settingsRef: { current: {} },
    imeCompositionDisposablesRef: { current: new Map() },
    imeNativeTextForwarderDisposablesRef: { current: new Map() }
  })
  const forwarded: ForwardedInput[] = []
  disposables.push(
    subscribeToTerminalInputData(terminal, (data, wasUserInput) =>
      forwarded.push({ data, wasUserInput })
    )
  )
  return { terminal, textarea: terminal.textarea!, forwarded }
}

function key(
  textarea: HTMLTextAreaElement,
  type: 'keydown' | 'keypress' | 'keyup',
  init: { key: string; code: string; keyCode: number }
): KeyboardEvent {
  const event = new KeyboardEvent(type, { ...init, bubbles: true, cancelable: true })
  // happy-dom drops the legacy numeric fields from KeyboardEventInit; xterm's key paths read them.
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  Object.defineProperty(event, 'charCode', { value: type === 'keypress' ? init.keyCode : 0 })
  textarea.dispatchEvent(event)
  return event
}

function insertText(textarea: HTMLTextAreaElement, inputType: string, data: string | null): void {
  const event = new InputEvent('input', { bubbles: true })
  Object.defineProperty(event, 'inputType', { value: inputType })
  Object.defineProperty(event, 'data', { value: data })
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

describe('IME and Hangul commits reach the PTY as user input', () => {
  let originalUserAgent: PropertyDescriptor | undefined
  let originalMaxTouchPoints: PropertyDescriptor | undefined

  beforeEach(() => {
    originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
    originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    for (const disposable of disposables.splice(0)) {
      disposable.dispose()
    }
    for (const [property, descriptor] of [
      ['userAgent', originalUserAgent],
      ['maxTouchPoints', originalMaxTouchPoints]
    ] as const) {
      if (descriptor) {
        Object.defineProperty(navigator, property, descriptor)
      }
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('marks a macOS input-source substitution as user input', () => {
    pretendIosWeb(0, MAC_UA)
    const { textarea, forwarded } = openPane()

    const keydown = key(textarea, 'keydown', { key: ',', code: 'Comma', keyCode: 188 })
    expect(keydown.defaultPrevented).toBe(false)
    textarea.value = '，'
    insertText(textarea, 'insertText', '，')
    key(textarea, 'keyup', { key: ',', code: 'Comma', keyCode: 188 })

    expect(forwarded).toEqual([{ data: '，', wasUserInput: true }])
  })

  it('marks an iPadOS Hangul syllable commit as user input', async () => {
    pretendIosWeb(5, IPAD_DESKTOP_MODE_UA)
    const { textarea, forwarded } = openPane()
    const typeJamo = async (jamo: string, written: string, replaces: boolean) => {
      if (
        !key(textarea, 'keydown', { key: jamo, code: 'KeyQ', keyCode: jamo.charCodeAt(0) })
          .defaultPrevented
      ) {
        key(textarea, 'keypress', { key: jamo, code: 'KeyQ', keyCode: jamo.charCodeAt(0) })
      }
      if (replaces) {
        textarea.value = textarea.value.slice(0, -1)
        insertText(textarea, 'deleteContentBackward', null)
      }
      textarea.value += written
      insertText(textarea, 'insertText', written)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    }

    await typeJamo('ㅎ', 'ㅎ', false)
    await typeJamo('ㅏ', '하', true)
    await typeJamo('ㄴ', '한', true)
    await typeJamo('ㄱ', 'ㄱ', false)

    expect(forwarded).toEqual([{ data: '한', wasUserInput: true }])
  })

  it('marks a composition the route delivers after a pane switch as user input', () => {
    const { terminal, forwarded } = openPane()
    const transport: Pick<PtyTransport, 'getPtyId'> = { getPtyId: () => 'pty-1' }
    disposables.push(
      installTerminalImeCompositionRoute({
        terminalElement: terminal.element!,
        terminal,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route reads only getPtyId.
        capturedTransport: transport as PtyTransport,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: compared by identity only.
        getCurrentTransport: () => transport as PtyTransport
      })
    )
    const session = (type: string, data?: string): CustomEvent =>
      new CustomEvent(type, {
        bubbles: true,
        cancelable: true,
        detail: { id: 1, data, dataPendingReconciliation: false }
      })

    terminal.element!.dispatchEvent(session(XTERM_COMPOSITION_SESSION_START_EVENT))
    terminal.element!.dispatchEvent(session(XTERM_COMPOSITION_SESSION_END_EVENT, '한'))

    expect(forwarded).toEqual([{ data: '한', wasUserInput: true }])
  })
})
