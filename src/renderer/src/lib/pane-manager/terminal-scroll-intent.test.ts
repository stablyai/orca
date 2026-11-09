import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureTerminalStructuralScrollIntent,
  getTerminalScrollIntentKind,
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  restoreTerminalStructuralScrollIntent
} from './terminal-scroll-intent'

import { attachTerminalScrollIntentTracking } from './terminal-scroll-intent-dom-tracking'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild
} from './terminal-scroll-intent-rebuild'

function createTerminal({
  viewportY,
  baseY,
  type = 'normal'
}: {
  viewportY: number
  baseY: number
  type?: 'normal' | 'alternate'
}) {
  const terminal = {
    buffer: {
      active: {
        type,
        viewportY,
        baseY
      }
    },
    scrollToBottom: vi.fn(() => {
      terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      terminal.buffer.active.viewportY = line
    })
  }
  return terminal
}

class TestElement extends EventTarget {}

describe('terminal scroll intent', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not let an old terminal disposal overwrite its keyed successor', () => {
    vi.stubGlobal('Element', TestElement)
    const firstTerminal = createTerminal({ viewportY: 76, baseY: 100 })
    const firstDisposable = attachTerminalScrollIntentTracking(
      firstTerminal,
      new TestElement() as unknown as HTMLElement,
      'leaf-dispose-successor'
    )
    markTerminalPinnedViewport(firstTerminal)

    const successor = createTerminal({ viewportY: 100, baseY: 100 })
    const successorDisposable = attachTerminalScrollIntentTracking(
      successor,
      new TestElement() as unknown as HTMLElement,
      'leaf-dispose-successor'
    )
    markTerminalFollowOutput(successor)
    firstTerminal.buffer.active.baseY = 150
    firstDisposable.dispose()

    expect(getTerminalScrollIntentKind(successor)).toBe('followOutput')
    successorDisposable.dispose()
  })

  it('keeps rebuild wheel intent when xterm classifies the same event as mouse input', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const { terminal, capturedInput, capturedUserInput } = createTerminalWithInputCapture({
      viewportY: 80,
      baseY: 100
    })
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
    capturedInput.listener?.('\x1b[<64;10;5M')
    await Promise.resolve()
    terminal.buffer.active.viewportY = 200
    terminal.buffer.active.baseY = 200
    endTerminalScrollIntentBufferRebuild(terminal)
    restoreTerminalStructuralScrollIntent(terminal, staleIntent, { restoreBy: 'bottomOffset' })
    await Promise.resolve()

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(180)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
    disposable.dispose()
  })

  function createTerminalWithInputCapture(args: { viewportY: number; baseY: number }) {
    const capturedInput: { listener: ((data: string) => void) | null } = { listener: null }
    const capturedUserInput: { listener: (() => void) | null } = { listener: null }
    const terminal = createTerminal(args) as ReturnType<typeof createTerminal> & {
      onData?: (listener: (data: string) => void) => { dispose: () => void }
      _core?: { coreService: { onUserInput: (listener: () => void) => { dispose: () => void } } }
    }
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
})
