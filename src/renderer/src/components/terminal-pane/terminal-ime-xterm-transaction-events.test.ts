// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { Terminal as EsmTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installTerminalImeNativeTextForwarder,
  XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT,
  XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT
} from './terminal-ime-native-text-forwarder'

const requireFromHere = createRequire(import.meta.url)
const { Terminal: CjsTerminal } = requireFromHere('@xterm/xterm') as {
  Terminal: typeof EsmTerminal
}
const EXPECTED_XTERM_VERSION = '6.1.0-beta.287'

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function dispatchWonKeyEvent(
  textarea: HTMLTextAreaElement,
  type: 'keydown' | 'keypress' | 'keyup',
  key: string
): void {
  const event = new KeyboardEvent(type, { key, code: 'Backquote', bubbles: true })
  Object.defineProperties(event, {
    charCode: { value: type === 'keypress' ? key.charCodeAt(0) : 0 },
    keyCode: { value: 192 },
    which: { value: type === 'keypress' ? key.charCodeAt(0) : 192 }
  })
  textarea.dispatchEvent(event)
}

async function openComposedTerminal(TerminalType: typeof EsmTerminal): Promise<{
  terminal: EsmTerminal
  textarea: HTMLTextAreaElement
  events: string[]
  output: string[]
}> {
  const terminal = new TerminalType()
  const container = document.createElement('div')
  document.body.appendChild(container)
  terminal.open(container)
  if (!terminal.element || !terminal.textarea) {
    throw new Error('xterm input elements were not created')
  }
  const events: string[] = []
  const output: string[] = []
  terminal.onData((data) => output.push(data))
  terminal.element.addEventListener(XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT, () => {
    events.push('accepted')
  })
  terminal.element.addEventListener(XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT, () => {
    events.push('settled')
  })
  terminal.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  terminal.textarea.dispatchEvent(
    new CompositionEvent('compositionupdate', { data: '한', bubbles: true })
  )
  terminal.textarea.value = '한'
  terminal.textarea.setSelectionRange(1, 1)
  await nextEventLoop()
  return { terminal, textarea: terminal.textarea, events, output }
}

describe.each([
  ['ESM', EsmTerminal],
  ['CJS', CjsTerminal]
])('xterm composition transaction events (%s)', (_format, TerminalType) => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('reports the expected package version from the patched bundle', async () => {
    const terminal = new TerminalType()
    const output: string[] = []
    terminal.onData((data) => output.push(data))

    await new Promise<void>((resolve) => terminal.write('\x1b[>0q', resolve))

    // The banner is the compiled-in XTERM_VERSION, so this reads the bundle
    // itself. Provenance against the pinned commit is the generator's job.
    expect(output).toEqual([`\x1bP>|xterm.js(${EXPECTED_XTERM_VERSION})\x1b\\`])
    terminal.dispose()
  })

  it('settles after the deferred finalizer completes', async () => {
    const { terminal, textarea, events } = await openComposedTerminal(TerminalType)

    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    expect(events).toEqual(['accepted'])
    await nextEventLoop()

    expect(events).toEqual(['accepted', 'settled'])
    terminal.dispose()
  })

  it('settles synchronously when an ordinary keydown flushes the finalizer', async () => {
    const { terminal, textarea, events } = await openComposedTerminal(TerminalType)

    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    const keydown = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true })
    Object.defineProperty(keydown, 'keyCode', { value: 65 })
    textarea.dispatchEvent(keydown)

    expect(events).toEqual(['accepted', 'settled'])
    terminal.dispose()
  })

  it('settles the old transaction before accepting a restarted composition', async () => {
    const { terminal, textarea, events } = await openComposedTerminal(TerminalType)

    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '글', bubbles: true }))
    textarea.value = '한글'
    textarea.setSelectionRange(2, 2)
    await nextEventLoop()
    expect(events).toEqual(['accepted', 'settled'])

    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '글', bubbles: true }))
    expect(events).toEqual(['accepted', 'settled', 'accepted'])
    await nextEventLoop()

    expect(events).toEqual(['accepted', 'settled', 'accepted', 'settled'])
    terminal.dispose()
  })

  it('settles every immediately completed restarted composition', async () => {
    const { terminal, textarea, events, output } = await openComposedTerminal(TerminalType)

    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '글', bubbles: true }))
    textarea.value = '한글'
    textarea.setSelectionRange(2, 2)
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '글', bubbles: true }))

    expect(events).toEqual(['accepted', 'settled', 'accepted'])
    await nextEventLoop()

    expect(events).toEqual(['accepted', 'settled', 'accepted', 'settled'])
    expect(output.join('')).toBe('한글')
    terminal.dispose()
  })

  it('rejects immediate duplicate composition ends', async () => {
    const { terminal, textarea, events, output } = await openComposedTerminal(TerminalType)

    for (let index = 0; index < 3; index++) {
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    }
    expect(events).toEqual(['accepted'])
    await nextEventLoop()

    expect(events).toEqual(['accepted', 'settled'])
    expect(output).toEqual(['한'])
    terminal.dispose()
  })

  it('rejects stale composition ends after settlement', async () => {
    const { terminal, textarea, events, output } = await openComposedTerminal(TerminalType)
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: terminal.element,
      isComposing: () => false,
      sendInput: (data) => terminal.input(data)
    })
    terminal.attachCustomKeyEventHandler((event) => !forwarder.claimKeyEvent(event))

    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    await nextEventLoop()
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    dispatchWonKeyEvent(textarea, 'keydown', '₩')
    dispatchWonKeyEvent(textarea, 'keypress', '`')
    textarea.value = '`'
    textarea.dispatchEvent(
      new InputEvent('input', { data: '`', inputType: 'insertText', bubbles: true })
    )
    dispatchWonKeyEvent(textarea, 'keyup', '₩')
    await nextEventLoop()

    expect(events).toEqual(['accepted', 'settled'])
    expect(output).toEqual(['한', '`'])
    forwarder.dispose()
    terminal.dispose()
  })

  it('leaves an accepted transaction aborted when disposal cancels its finalizer', async () => {
    const { terminal, textarea, events, output } = await openComposedTerminal(TerminalType)

    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    expect(events).toEqual(['accepted'])
    terminal.dispose()
    await nextEventLoop()

    expect(events).toEqual(['accepted'])
    expect(output).toEqual([])
  })
})
