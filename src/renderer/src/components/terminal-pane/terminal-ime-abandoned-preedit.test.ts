// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeCompositionRoute } from './terminal-ime-composition-route'
import type { PtyTransport } from './pty-transport'
import { installPreviewImeBridge } from '../dashboard-popout/preview-terminal-ime-bridge'

const PTY_ID = 'pty-1'

function nextEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  window.setTimeout(resolve, 0)
  return promise
}

function openRoutedTerminal(): {
  routed: string[]
  emitted: string[]
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea
  const element = terminal.element
  if (!textarea || !element) {
    throw new Error('xterm helper textarea was not created')
  }
  const routed: string[] = []
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  const transport = { getPtyId: () => PTY_ID } as unknown as PtyTransport
  installTerminalImeCompositionRoute({
    terminalElement: element,
    terminal: { input: (data) => routed.push(data) },
    capturedTransport: transport,
    getCurrentTransport: () => transport
  })
  return { routed, emitted, textarea }
}

function composition(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data = ''
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  // happy-dom ignores CompositionEventInit.data, but Chromium supplies it.
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

function setPreedit(textarea: HTMLTextAreaElement, text: string): void {
  textarea.value = text
  textarea.setSelectionRange(text.length, text.length)
  const event = new InputEvent('input', {
    data: text,
    inputType: 'insertCompositionText',
    bubbles: true
  })
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

function imeKeydown(textarea: HTMLTextAreaElement, key: string, keyCode: number): void {
  const event = new KeyboardEvent('keydown', { key, code: key, isComposing: true, bubbles: true })
  Object.defineProperty(event, 'keyCode', { value: keyCode })
  textarea.dispatchEvent(event)
}

describe('IME preedit abandoned by Backspace', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  // Backspace during composition is IME-owned: shouldSuppressTerminalImeKeyboardEvent keeps it
  // away from xterm's key handler, so only the composition lifecycle can reach the PTY.
  // The two dialects differ in whether the emptied preedit gets its own compositionupdate.
  for (const blanksPreeditFirst of [true, false]) {
    it(`sends nothing to the PTY when Backspace empties the last preedit symbol (blank update: ${blanksPreeditFirst})`, async () => {
      const { routed, emitted, textarea } = openRoutedTerminal()

      composition(textarea, 'compositionstart')
      composition(textarea, 'compositionupdate', 'ㄑ')
      setPreedit(textarea, 'ㄑ')
      await nextEventLoop()

      // macOS reports the IME-consumed Backspace as keyCode 229.
      imeKeydown(textarea, 'Backspace', 229)
      if (blanksPreeditFirst) {
        composition(textarea, 'compositionupdate', '')
        setPreedit(textarea, '')
      }
      composition(textarea, 'compositionend', '')
      textarea.value = ''
      await nextEventLoop()
      await nextEventLoop()

      expect(routed).toEqual([])
      expect(emitted).toEqual([])
    })
  }

  it('keeps composing when Backspace only shrinks a multi-character preedit', async () => {
    const { routed, emitted, textarea } = openRoutedTerminal()

    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '你好')
    setPreedit(textarea, '你好')
    await nextEventLoop()

    imeKeydown(textarea, 'Backspace', 229)
    composition(textarea, 'compositionupdate', '你')
    setPreedit(textarea, '你')
    await nextEventLoop()
    await nextEventLoop()

    expect(routed).toEqual([])
    expect(emitted).toEqual([])
  })

  it('still routes a real commit that follows an emptied preedit', async () => {
    const { routed, textarea } = openRoutedTerminal()

    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', 'ㄅ')
    setPreedit(textarea, 'ㄅ')
    await nextEventLoop()

    imeKeydown(textarea, 'Backspace', 229)
    composition(textarea, 'compositionupdate', '')
    setPreedit(textarea, '')
    composition(textarea, 'compositionend', '')
    await nextEventLoop()
    await nextEventLoop()

    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '好')
    setPreedit(textarea, '好')
    composition(textarea, 'compositionend', '好')
    await nextEventLoop()
    await nextEventLoop()

    expect(routed).toEqual(['好'])
  })

  it('routes a Sogou-style commit announced by an empty compositionupdate', async () => {
    const { routed, textarea } = openRoutedTerminal()

    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', 'ni')
    setPreedit(textarea, 'ni')
    await nextEventLoop()

    // Candidate window open: Sogou/fcitx blank the preedit before committing.
    composition(textarea, 'compositionupdate', '')
    composition(textarea, 'compositionend', '你')
    setPreedit(textarea, '你')
    await nextEventLoop()
    await nextEventLoop()

    expect(routed).toEqual(['你'])
  })

  it('routes a commit whose text only lands on the input event after an empty compositionend', async () => {
    const { routed, textarea } = openRoutedTerminal()

    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', 'ni')
    setPreedit(textarea, 'ni')
    await nextEventLoop()

    // fcitx/IBus dialect: compositionend carries nothing, the commit arrives as the next input.
    composition(textarea, 'compositionend', '')
    setPreedit(textarea, '你')
    await nextEventLoop()
    await nextEventLoop()

    expect(routed).toEqual(['你'])
  })

  it('keeps the abandoned preedit out of the routeless popout preview terminal', async () => {
    const container = document.createElement('div')
    document.body.replaceChildren(container)
    const terminal = new Terminal()
    terminal.open(container)
    const textarea = terminal.textarea
    if (!textarea) {
      throw new Error('xterm helper textarea was not created')
    }
    const emitted: string[] = []
    terminal.onData((data) => emitted.push(data))
    installPreviewImeBridge(terminal)

    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', 'ㄅ')
    setPreedit(textarea, 'ㄅ')
    await nextEventLoop()

    imeKeydown(textarea, 'Backspace', 229)
    composition(textarea, 'compositionupdate', '')
    setPreedit(textarea, '')
    composition(textarea, 'compositionend', '')
    await nextEventLoop()
    await nextEventLoop()

    expect(emitted).toEqual([])
  })
})
