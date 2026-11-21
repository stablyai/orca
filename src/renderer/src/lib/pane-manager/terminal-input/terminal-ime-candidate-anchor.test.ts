// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeCandidateAnchor } from './terminal-ime-candidate-anchor'

const CELL_WIDTH = 10
const CELL_HEIGHT = 20

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function compose(textarea: HTMLTextAreaElement, type: string, data?: string): void {
  const event = new CompositionEvent(type, { bubbles: true })
  if (data !== undefined) {
    Object.defineProperty(event, 'data', { value: data })
  }
  textarea.dispatchEvent(event)
}

const CURSOR_AGENT_SCREEN = 'Cursor Agent\r\n\r\n\r\n\r\n\r\n\r\n → abc\r\n\r\n'

function openTerminal(): { terminal: Terminal; compositionView: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 40, rows: 10 })
  terminal.open(container)
  const screen = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 40 * CELL_WIDTH, 10 * CELL_HEIGHT)
  )
  const compositionView = terminal.element!.querySelector<HTMLElement>('.composition-view')!
  return { terminal, compositionView }
}

function countLiveRenderSubscriptions(terminal: Terminal): () => number {
  const onRender = terminal.onRender
  let live = 0
  const countedOnRender: typeof onRender = (listener) => {
    live++
    const subscription = onRender(listener)
    return {
      dispose: () => {
        live--
        subscription.dispose()
      }
    }
  }
  Object.defineProperty(terminal, 'onRender', { value: countedOnRender })
  return () => live
}

async function startCursorAgentComposition(terminal: Terminal): Promise<void> {
  await write(terminal, CURSOR_AGENT_SCREEN)
  await nextFrame()
  compose(terminal.textarea!, 'compositionstart')
  compose(terminal.textarea!, 'compositionupdate', '한')
}

describe('installTerminalImeCandidateAnchor', () => {
  beforeEach(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm only calls measureText on this stub.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: CELL_WIDTH })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('keeps the Cursor Agent preedit on the prompt when xterm repaints mid-composition', async () => {
    const { terminal, compositionView } = openTerminal()
    try {
      installTerminalImeCandidateAnchor(terminal)
      // Cursor Agent parks the real cursor at column 0 of a blank row below its prompt.
      await startCursorAgentComposition(terminal)
      await nextEventLoop()
      await nextEventLoop()
      expect(compositionView.style.top).toBe(`${6 * CELL_HEIGHT}px`)
      expect(compositionView.style.left).toBe(`${6 * CELL_WIDTH}px`)

      // Echoing the previous syllable repaints mid-composition and leaves the cursor parked again.
      await write(terminal, '\x1b7\x1b[7;7H가\x1b8')
      await nextFrame()
      await nextEventLoop()
      await nextEventLoop()
      expect(compositionView.style.top).toBe(`${6 * CELL_HEIGHT}px`)
      expect(compositionView.style.left).toBe(`${8 * CELL_WIDTH}px`)

      // A transient frame without the prompt must not stop later renders from re-anchoring.
      await write(terminal, '\x1b[2J\x1b[Habcd')
      await nextFrame()
      await write(terminal, `\x1b[H${CURSOR_AGENT_SCREEN}`)
      await nextFrame()
      await nextEventLoop()
      await nextEventLoop()
      expect(compositionView.style.top).toBe(`${6 * CELL_HEIGHT}px`)
    } finally {
      terminal.dispose()
    }
  })

  it('follows the painted prompt when scrolling moves it', async () => {
    const { terminal, compositionView } = openTerminal()
    try {
      installTerminalImeCandidateAnchor(terminal)
      await startCursorAgentComposition(terminal)
      await nextEventLoop()

      terminal.refresh(0, terminal.rows - 1)
      await nextFrame()
      await nextEventLoop()
      await nextEventLoop()
      expect(compositionView.style.top).toBe(`${6 * CELL_HEIGHT}px`)

      // Scrolling moves the prompt with the parked cursor, which invalidates the cache and rescans.
      await write(terminal, '\r\n\r\n')
      await nextFrame()
      expect(compositionView.style.top).toBe(`${5 * CELL_HEIGHT}px`)
    } finally {
      terminal.dispose()
    }
  })

  it.each(['compositionend', 'blur'])(
    'stops following renders on the first render after %s ends the composition',
    async (stopEvent) => {
      const { terminal, compositionView } = openTerminal()
      try {
        const liveRenderSubscriptions = countLiveRenderSubscriptions(terminal)
        installTerminalImeCandidateAnchor(terminal)
        expect(liveRenderSubscriptions()).toBe(0)
        await startCursorAgentComposition(terminal)
        expect(liveRenderSubscriptions()).toBe(1)

        if (stopEvent === 'compositionend') {
          terminal.textarea!.value = '한'
          compose(terminal.textarea!, 'compositionend', '한')
        } else {
          terminal.textarea!.dispatchEvent(new FocusEvent('blur'))
        }
        expect(compositionView.classList.contains('active')).toBe(false)
        terminal.refresh(0, terminal.rows - 1)
        await nextFrame()
        expect(liveRenderSubscriptions()).toBe(0)
      } finally {
        terminal.dispose()
      }
    }
  )

  it('keeps following renders when xterm ignores a stray compositionend', async () => {
    const { terminal, compositionView } = openTerminal()
    try {
      const liveRenderSubscriptions = countLiveRenderSubscriptions(terminal)
      installTerminalImeCandidateAnchor(terminal)
      await startCursorAgentComposition(terminal)
      // An end whose data does not match the live preedit belongs to another transaction.
      compose(terminal.textarea!, 'compositionend', '가')
      await nextEventLoop()
      terminal.refresh(0, terminal.rows - 1)
      await nextFrame()
      expect(compositionView.classList.contains('active')).toBe(true)
      expect(liveRenderSubscriptions()).toBe(1)
    } finally {
      terminal.dispose()
    }
  })

  it('stops following renders and drops the pending correction on cleanup', async () => {
    const { terminal, compositionView } = openTerminal()
    try {
      const liveRenderSubscriptions = countLiveRenderSubscriptions(terminal)
      const cleanup = installTerminalImeCandidateAnchor(terminal)!
      await startCursorAgentComposition(terminal)
      expect(liveRenderSubscriptions()).toBe(1)

      cleanup()
      expect(liveRenderSubscriptions()).toBe(0)
      compositionView.style.top = '1px'
      await nextEventLoop()
      await nextEventLoop()
      expect(compositionView.style.top).not.toBe(`${6 * CELL_HEIGHT}px`)
    } finally {
      terminal.dispose()
    }
  })
})
