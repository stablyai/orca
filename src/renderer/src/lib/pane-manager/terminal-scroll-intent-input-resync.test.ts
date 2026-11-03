import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalScrollIntentTracking } from './terminal-scroll-intent-dom-tracking'
import {
  captureTerminalStructuralScrollIntent,
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

class TestElement extends EventTarget {}

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
})
