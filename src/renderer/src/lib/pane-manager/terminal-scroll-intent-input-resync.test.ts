import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalScrollIntentTracking } from './terminal-scroll-intent-dom-tracking'
import {
  captureTerminalStructuralScrollIntent,
  enforceTerminalCurrentScrollIntent,
  getTerminalScrollIntentKind,
  markTerminalPinnedViewport,
  restoreTerminalStructuralScrollIntent
} from './terminal-scroll-intent'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild
} from './terminal-scroll-intent-rebuild'

function createTerminal(viewportY: number, baseY: number) {
  const terminal = {
    buffer: { active: { type: 'normal' as const, viewportY, baseY } },
    scrollToBottom: vi.fn(() => {
      terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      terminal.buffer.active.viewportY = line
    }),
    onData: undefined as
      | ((listener: (data: string) => void) => { dispose: () => void })
      | undefined,
    _core: undefined as
      | { coreService: { onUserInput: (listener: () => void) => { dispose: () => void } } }
      | undefined
  }
  return terminal
}

class TestElement extends EventTarget {
  parentElement: TestElement | null = null
  readonly classList = {
    contains: (className: string): boolean => this.className.split(/\s+/).includes(className)
  }

  constructor(public className = '') {
    super()
  }

  closest(selector: string): TestElement | null {
    for (const candidate of selector.split(',')) {
      const trimmed = candidate.trim()
      if (trimmed.startsWith('.') && this.classList.contains(trimmed.slice(1))) {
        return this
      }
    }
    return this.parentElement?.closest(selector) ?? null
  }
}

function createTerminalWithInputCapture(viewportY: number, baseY: number) {
  const capturedInput: { listener: ((data: string) => void) | null } = { listener: null }
  const capturedUserInput: { listener: (() => void) | null } = { listener: null }
  const terminal = createTerminal(viewportY, baseY)
  terminal.onData = (listener: (data: string) => void) => {
    capturedInput.listener = listener
    return { dispose: vi.fn() }
  }
  terminal._core = {
    coreService: {
      onUserInput: (listener: () => void) => {
        capturedUserInput.listener = listener
        return { dispose: vi.fn() }
      }
    }
  }
  return { terminal, capturedInput, capturedUserInput }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('terminal scroll-intent input resync', () => {
  it('heals a stale pin when typing scrolls the terminal to the bottom', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const { terminal, capturedInput, capturedUserInput } = createTerminalWithInputCapture(42, 100)
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    markTerminalPinnedViewport(terminal)
    terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    capturedUserInput.listener?.()
    capturedInput.listener?.('a')

    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
    disposable.dispose()
  })

  it('heals a stale pre-reflow pin when typing reaches a shorter buffer bottom', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const { terminal, capturedInput, capturedUserInput } = createTerminalWithInputCapture(42, 100)
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    markTerminalPinnedViewport(terminal)
    terminal.buffer.active.baseY = 70
    terminal.buffer.active.viewportY = 70
    capturedUserInput.listener?.()
    capturedInput.listener?.('a')

    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
    disposable.dispose()
  })

  it('keeps a real pin when app-consumed input does not move the viewport', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const { terminal, capturedInput, capturedUserInput } = createTerminalWithInputCapture(42, 100)
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    markTerminalPinnedViewport(terminal)
    capturedUserInput.listener?.()
    capturedInput.listener?.('\x1b[5~')

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
    terminal.buffer.active.viewportY = 0
    enforceTerminalCurrentScrollIntent(terminal)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(42)
    disposable.dispose()
  })

  it('does not reclassify a pin from mouse reports even when they scroll to bottom', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const { terminal, capturedInput, capturedUserInput } = createTerminalWithInputCapture(42, 100)
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    markTerminalPinnedViewport(terminal)
    terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    capturedUserInput.listener?.()
    capturedInput.listener?.('\x1b[<35;10;5M')

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
    expect(terminal.buffer.active.viewportY).toBe(42)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(42)
    disposable.dispose()
  })

  it('does not let a focus reply make a following mouse report reclassify the pin', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const { terminal, capturedInput, capturedUserInput } = createTerminalWithInputCapture(42, 100)
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    markTerminalPinnedViewport(terminal)
    capturedInput.listener?.('\x1b[I')
    terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    capturedUserInput.listener?.()
    capturedInput.listener?.('\x1b[<0;10;5M')

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
    disposable.dispose()
  })

  it('ignores a parser reply that has no matching user-input signal', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const { terminal, capturedInput } = createTerminalWithInputCapture(42, 100)
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    markTerminalPinnedViewport(terminal)
    terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    capturedInput.listener?.('\x1b[1;1R')

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
    disposable.dispose()
  })

  it('does not apply input resync after tracking is disposed', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const { terminal, capturedInput, capturedUserInput } = createTerminalWithInputCapture(42, 100)
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    markTerminalPinnedViewport(terminal)
    capturedUserInput.listener?.()
    disposable.dispose()
    terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    capturedInput.listener?.('a')

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
  })

  it('defers real typing intent until a snapshot rebuild completes', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const { terminal, capturedInput, capturedUserInput } = createTerminalWithInputCapture(42, 100)
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)
    markTerminalPinnedViewport(terminal)
    const staleIntent = captureTerminalStructuralScrollIntent(terminal)
    beginTerminalScrollIntentBufferRebuild(terminal)

    terminal.buffer.active.baseY = 5
    terminal.buffer.active.viewportY = 5
    capturedUserInput.listener?.()
    capturedInput.listener?.('a')
    terminal.buffer.active.baseY = 200
    terminal.buffer.active.viewportY = 200
    endTerminalScrollIntentBufferRebuild(terminal)
    restoreTerminalStructuralScrollIntent(terminal, staleIntent, { restoreBy: 'bottomOffset' })

    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
    disposable.dispose()
  })

  it('lets later typing supersede a wheel-up pin during snapshot replay', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const { terminal, capturedInput, capturedUserInput } = createTerminalWithInputCapture(80, 100)
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)
    markTerminalPinnedViewport(terminal)
    const staleIntent = captureTerminalStructuralScrollIntent(terminal)
    beginTerminalScrollIntentBufferRebuild(terminal)

    terminal.buffer.active.viewportY = 0
    terminal.buffer.active.baseY = 0
    const wheel = new Event('wheel') as WheelEvent
    Object.defineProperty(wheel, 'deltaY', { value: -10 })
    host.dispatchEvent(wheel)
    capturedUserInput.listener?.()
    capturedInput.listener?.('a')
    terminal.buffer.active.viewportY = 200
    terminal.buffer.active.baseY = 200
    endTerminalScrollIntentBufferRebuild(terminal)
    restoreTerminalStructuralScrollIntent(terminal, staleIntent, { restoreBy: 'bottomOffset' })

    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
    disposable.dispose()
  })

  it('ignores parser auto-replies while a snapshot rebuild is partial', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const { terminal, capturedInput } = createTerminalWithInputCapture(42, 100)
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)
    markTerminalPinnedViewport(terminal)
    const intent = captureTerminalStructuralScrollIntent(terminal)
    beginTerminalScrollIntentBufferRebuild(terminal)

    terminal.buffer.active.baseY = 5
    terminal.buffer.active.viewportY = 5
    capturedInput.listener?.('\x1b[1;1R')
    terminal.buffer.active.baseY = 200
    terminal.buffer.active.viewportY = 200
    endTerminalScrollIntentBufferRebuild(terminal)
    restoreTerminalStructuralScrollIntent(terminal, intent, { restoreBy: 'bottomOffset' })

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(142)
    disposable.dispose()
  })

  it('supports bottom-offset restore for structural buffer rebuilds', () => {
    const terminal = createTerminal(550, 600)
    markTerminalPinnedViewport(terminal)
    const snapshot = captureTerminalStructuralScrollIntent(terminal)
    terminal.buffer.active.baseY = 80
    terminal.buffer.active.viewportY = 80

    restoreTerminalStructuralScrollIntent(terminal, snapshot, { restoreBy: 'bottomOffset' })

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(30)
    expect(terminal.buffer.active.viewportY).toBe(30)
  })

  it('retains the intended bottom-offset pin when renderer dimensions reject restore', () => {
    const terminal = createTerminal(80, 100)
    markTerminalPinnedViewport(terminal)
    const snapshot = captureTerminalStructuralScrollIntent(terminal)
    terminal.buffer.active.baseY = 200
    terminal.buffer.active.viewportY = 200
    terminal.scrollToLine.mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    })

    restoreTerminalStructuralScrollIntent(terminal, snapshot, { restoreBy: 'bottomOffset' })
    expect(terminal.buffer.active.viewportY).toBe(200)

    terminal.buffer.active.viewportY = 0
    enforceTerminalCurrentScrollIntent(terminal)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(180)
  })
})
