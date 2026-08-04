// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyTransport } from './pty-transport'
import {
  installTerminalImeCompositionRoute,
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'
import { sendTerminalInputAfterComposition } from './terminal-ime-deferred-newline'

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function dispatchComposition(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data = ''
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

describe('deferred terminal newline through xterm composition sessions', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('releases after its captured xterm session despite a later session', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const terminal = new Terminal()
    terminal.open(container)
    const terminalElement = terminal.element
    const textarea = terminal.textarea
    if (!terminalElement || !textarea) {
      throw new Error('xterm input surface was not created')
    }

    const sessionOrder: string[] = []
    terminalElement.addEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, (event) => {
      sessionOrder.push(`start:${(event as CustomEvent<{ id: number }>).detail.id}`)
    })
    terminalElement.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, (event) => {
      sessionOrder.push(`end:${(event as CustomEvent<{ id: number }>).detail.id}`)
    })
    const emitted: string[] = []
    terminal.onData((data) => emitted.push(data))
    const transport = { getPtyId: () => 'pty-1' } as unknown as PtyTransport
    const route = installTerminalImeCompositionRoute({
      terminalElement,
      terminal,
      capturedTransport: transport,
      getCurrentTransport: () => transport
    })

    dispatchComposition(textarea, 'compositionstart')
    dispatchComposition(textarea, 'compositionupdate', '한')
    textarea.value = '한'
    textarea.setSelectionRange(1, 1)
    sendTerminalInputAfterComposition(terminalElement, () => terminal.input('\n'))
    dispatchComposition(textarea, 'compositionend', '한')
    dispatchComposition(textarea, 'compositionstart')

    expect(sessionOrder).toEqual(['start:1', 'start:2'])
    await nextEventLoop()
    await nextEventLoop()
    expect(sessionOrder).toEqual(['start:1', 'start:2', 'end:1'])
    expect(emitted.join('')).toBe('한\n')

    route.dispose()
    terminal.dispose()
  })
})
