// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeCompositionTracker } from './terminal-ime-composition-tracker'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function compositionEvent(type: string, data = ''): CompositionEvent {
  const event = new CompositionEvent(type, { data, bubbles: true })
  Object.defineProperty(event, 'data', { value: data })
  return event
}

function keyboardEvent(
  type: 'keydown' | 'keypress' | 'keyup',
  key: string,
  code = 'Backquote',
  keyCode = 192
): KeyboardEvent {
  const event = new KeyboardEvent(type, { key, code, bubbles: true })
  Object.defineProperties(event, {
    charCode: { value: type === 'keypress' ? key.charCodeAt(0) : 0 },
    keyCode: { value: keyCode },
    which: { value: type === 'keypress' ? key.charCodeAt(0) : keyCode }
  })
  return event
}

async function typeHangulThenWon(
  committedWonTexts: readonly ('`' | '₩')[],
  options: {
    beforeWon?: (textarea: HTMLTextAreaElement) => void
    duplicateFirstInput?: boolean
  } = {}
): Promise<string> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea
  const terminalElement = terminal.element
  if (!textarea || !terminalElement) {
    throw new Error('xterm input elements were not created')
  }

  const tracker = installTerminalImeCompositionTracker(terminalElement)
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement,
    isComposing: tracker.isActive,
    sendInput: (data) => terminal.input(data)
  })
  terminal.attachCustomKeyEventHandler((event) => !forwarder.claimKeyEvent(event))

  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  textarea.dispatchEvent(compositionEvent('compositionstart'))
  textarea.dispatchEvent(compositionEvent('compositionupdate', '한'))
  textarea.value = '한'
  textarea.setSelectionRange(1, 1)
  await nextEventLoop()

  textarea.dispatchEvent(compositionEvent('compositionend', '한'))
  options.beforeWon?.(textarea)
  for (const [index, committedWonText] of committedWonTexts.entries()) {
    textarea.dispatchEvent(keyboardEvent('keydown', '₩'))
    textarea.dispatchEvent(keyboardEvent('keypress', committedWonText))
    textarea.value += committedWonText
    textarea.dispatchEvent(
      new InputEvent('input', {
        data: committedWonText,
        inputType: 'insertText',
        bubbles: true
      })
    )
    if (index === 0 && options.duplicateFirstInput) {
      textarea.dispatchEvent(
        new InputEvent('input', {
          data: committedWonText,
          inputType: 'insertText',
          bubbles: true
        })
      )
    }
    textarea.dispatchEvent(keyboardEvent('keyup', '₩'))
  }
  await nextEventLoop()

  forwarder.dispose()
  tracker.dispose()
  terminal.dispose()
  return emitted.join('')
}

async function typeHangulThenRepeatedStaleEndsThenWon(): Promise<string> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea
  const terminalElement = terminal.element
  if (!textarea || !terminalElement) {
    throw new Error('xterm input elements were not created')
  }

  const tracker = installTerminalImeCompositionTracker(terminalElement)
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement,
    isComposing: tracker.isActive,
    sendInput: (data) => terminal.input(data)
  })
  terminal.attachCustomKeyEventHandler((event) => !forwarder.claimKeyEvent(event))
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))

  textarea.dispatchEvent(compositionEvent('compositionstart'))
  textarea.dispatchEvent(compositionEvent('compositionupdate', '한'))
  textarea.value = '한'
  textarea.setSelectionRange(1, 1)
  textarea.dispatchEvent(compositionEvent('compositionend', '한'))
  await nextEventLoop()

  textarea.value = ''
  for (let index = 0; index < 3; index++) {
    textarea.dispatchEvent(compositionEvent('compositionend', '한'))
  }
  textarea.dispatchEvent(keyboardEvent('keydown', '₩'))
  textarea.dispatchEvent(keyboardEvent('keypress', '`'))
  textarea.value = '`'
  textarea.dispatchEvent(
    new InputEvent('input', { data: '`', inputType: 'insertText', bubbles: true })
  )
  textarea.dispatchEvent(keyboardEvent('keyup', '₩'))
  await nextEventLoop()

  forwarder.dispose()
  tracker.dispose()
  terminal.dispose()
  return emitted.join('')
}

describe('Korean won input after a composition commit', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it.each(['`', '₩'] as const)(
    'preserves composition-first order when won commits as %s',
    async (committedWonText) => {
      await expect(typeHangulThenWon([committedWonText])).resolves.toBe(`한${committedWonText}`)
    }
  )

  it('preserves back-to-back won transactions before the composition finalizer', async () => {
    await expect(typeHangulThenWon(['`', '₩'])).resolves.toBe('한`₩')
  })

  it('releases composition ownership when an ordinary keydown flushes the finalizer', async () => {
    await expect(
      typeHangulThenWon(['₩'], {
        beforeWon: (textarea) => {
          // Why: the full sequence a browser emits for an unprevented printable
          // key. The keydown alone is not a shape Chromium can produce, and the
          // `input` event is what carries the character now.
          textarea.dispatchEvent(keyboardEvent('keydown', 'a', 'KeyA', 65))
          textarea.dispatchEvent(keyboardEvent('keypress', 'a', 'KeyA', 65))
          textarea.value += 'a'
          textarea.dispatchEvent(
            new InputEvent('input', { data: 'a', inputType: 'insertText', bubbles: true })
          )
        }
      })
    ).resolves.toBe('한a₩')
  })

  it('suppresses a duplicate insertText without a new keydown or textarea mutation', async () => {
    await expect(typeHangulThenWon(['`'], { duplicateFirstInput: true })).resolves.toBe('한`')
  })

  it('preserves a 64-input native-text burst before the composition finalizer', async () => {
    const committed = Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? '`' : '₩'))
    await expect(typeHangulThenWon(committed)).resolves.toBe(`한${committed.join('')}`)
  })

  it('preserves an immediate won remap after repeated stale composition ends', async () => {
    await expect(typeHangulThenRepeatedStaleEndsThenWon()).resolves.toBe('한`')
  })
})
