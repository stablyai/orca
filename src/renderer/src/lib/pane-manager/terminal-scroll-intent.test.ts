import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindTerminalScrollIntentKey,
  captureTerminalStructuralScrollIntent,
  enforceTerminalCurrentScrollIntent,
  getTerminalScrollIntentKind,
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  restoreTerminalStructuralScrollIntent
} from './terminal-scroll-intent'
import { syncTerminalScrollIntentSoon } from './terminal-scroll-intent-settle'
import { attachTerminalScrollIntentTracking } from './terminal-scroll-intent-dom-tracking'
import {
  beginTerminalScrollIntentBufferRebuild,
  cancelTerminalScrollIntentBufferRebuildCompletions,
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

  it('keeps sampling briefly after wheel so delayed xterm scroll updates win', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    vi.stubGlobal('Element', TestElement)
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    const wheelUp = new Event('wheel') as WheelEvent
    Object.defineProperty(wheelUp, 'deltaY', { value: -10 })
    host.dispatchEvent(wheelUp)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')

    await Promise.resolve()
    frameCallbacks.shift()?.(16)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')

    terminal.buffer.active.viewportY = 76
    frameCallbacks.shift()?.(32)
    frameCallbacks.shift()?.(48)
    terminal.buffer.active.viewportY = 100
    enforceTerminalCurrentScrollIntent(terminal)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(76)

    disposable.dispose()
  })

  it('persists native pinned growth on disposal for the next keyed replay', () => {
    vi.stubGlobal('Element', TestElement)
    const firstTerminal = createTerminal({ viewportY: 76, baseY: 100 })
    const firstDisposable = attachTerminalScrollIntentTracking(
      firstTerminal,
      new TestElement() as unknown as HTMLElement,
      'leaf-dispose-growth'
    )
    markTerminalPinnedViewport(firstTerminal)
    firstTerminal.buffer.active.baseY = 120

    firstDisposable.dispose()

    const remountedTerminal = createTerminal({ viewportY: 0, baseY: 0 })
    const remountedDisposable = attachTerminalScrollIntentTracking(
      remountedTerminal,
      new TestElement() as unknown as HTMLElement,
      'leaf-dispose-growth'
    )
    const intent = captureTerminalStructuralScrollIntent(remountedTerminal)
    remountedTerminal.buffer.active.viewportY = 200
    remountedTerminal.buffer.active.baseY = 200
    restoreTerminalStructuralScrollIntent(remountedTerminal, intent, {
      restoreBy: 'bottomOffset'
    })

    expect(intent).toMatchObject({ viewportY: 76, baseY: 120 })
    expect(remountedTerminal.scrollToLine).toHaveBeenLastCalledWith(156)
    remountedDisposable.dispose()
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

  it('does not let a stale key-settle callback overwrite a remounted terminal', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    let firstTerminalIsCurrent = true
    const first = createTerminal({ viewportY: 100, baseY: 100 })
    bindTerminalScrollIntentKey(first, 'key-settle-remount')
    markTerminalPinnedViewport(first)
    first.buffer.active.viewportY = 50
    syncTerminalScrollIntentSoon(first, { shouldSync: () => firstTerminalIsCurrent })

    const replacement = createTerminal({ viewportY: 100, baseY: 100 })
    bindTerminalScrollIntentKey(replacement, 'key-settle-remount')
    markTerminalFollowOutput(replacement)
    firstTerminalIsCurrent = false
    await Promise.resolve()
    while (frameCallbacks.length > 0) {
      frameCallbacks.shift()?.(16)
    }
    vi.advanceTimersByTime(80)

    expect(getTerminalScrollIntentKind(replacement)).toBe('followOutput')
  })

  it('suspends intent capture and enforcement while a buffer rebuild is in flight', () => {
    const terminal = createTerminal({ viewportY: 248, baseY: 254 })
    markTerminalPinnedViewport(terminal)
    const preReplay = captureTerminalStructuralScrollIntent(terminal)
    beginTerminalScrollIntentBufferRebuild(terminal)

    terminal.buffer.active.baseY = 0
    terminal.buffer.active.viewportY = 0
    expect(captureTerminalStructuralScrollIntent(terminal)).toBeNull()
    enforceTerminalCurrentScrollIntent(terminal)

    terminal.buffer.active.baseY = 284
    terminal.buffer.active.viewportY = 0
    restoreTerminalStructuralScrollIntent(terminal, preReplay)
    expect(terminal.scrollToLine).not.toHaveBeenCalled()
    expect(terminal.scrollToBottom).not.toHaveBeenCalled()

    terminal.buffer.active.viewportY = 284
    endTerminalScrollIntentBufferRebuild(terminal)
    restoreTerminalStructuralScrollIntent(terminal, preReplay, { restoreBy: 'bottomOffset' })
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(278)
    expect(terminal.buffer.active.viewportY).toBe(278)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
  })

  it.each([
    { deltaY: -10, finalViewportY: 150, expectedKind: 'pinnedViewport', expectedLine: 150 },
    { deltaY: 10, finalViewportY: 200, expectedKind: 'followOutput', expectedLine: null }
  ])(
    'resyncs a $expectedKind wheel intent after a delayed rebuild',
    async ({ deltaY, finalViewportY, expectedKind, expectedLine }) => {
      vi.stubGlobal('requestAnimationFrame', () => 0)
      vi.stubGlobal('Element', TestElement)
      const terminal = createTerminal({ viewportY: 42, baseY: 100 })
      const host = new TestElement() as unknown as HTMLElement
      const disposable = attachTerminalScrollIntentTracking(terminal, host)
      markTerminalPinnedViewport(terminal)
      const staleIntent = captureTerminalStructuralScrollIntent(terminal)
      beginTerminalScrollIntentBufferRebuild(terminal)

      terminal.buffer.active.viewportY = 0
      terminal.buffer.active.baseY = 0
      const wheel = new Event('wheel') as WheelEvent
      Object.defineProperty(wheel, 'deltaY', { value: deltaY })
      host.dispatchEvent(wheel)
      terminal.buffer.active.viewportY = finalViewportY
      terminal.buffer.active.baseY = 200
      endTerminalScrollIntentBufferRebuild(terminal)
      restoreTerminalStructuralScrollIntent(terminal, staleIntent, {
        restoreBy: 'bottomOffset'
      })

      expect(getTerminalScrollIntentKind(terminal)).toBe(expectedKind)
      terminal.buffer.active.viewportY = 0
      terminal.scrollToLine.mockClear()
      enforceTerminalCurrentScrollIntent(terminal)
      if (expectedLine === null) {
        expect(terminal.scrollToBottom).toHaveBeenCalled()
      } else {
        expect(terminal.scrollToLine).toHaveBeenLastCalledWith(expectedLine)
      }
      disposable.dispose()
    }
  )

  it('preserves a durable pin when wheel-up lands on the cleared replay buffer', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const terminal = createTerminal({ viewportY: 80, baseY: 100 })
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
    terminal.buffer.active.viewportY = 200
    terminal.buffer.active.baseY = 200
    endTerminalScrollIntentBufferRebuild(terminal)
    restoreTerminalStructuralScrollIntent(terminal, staleIntent, { restoreBy: 'bottomOffset' })
    await Promise.resolve()

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(180)
    expect(terminal.buffer.active.viewportY).toBe(180)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
    disposable.dispose()
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

  it('does not resync deferred wheel intent from a canceled partial rebuild', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('Element', TestElement)
    const terminal = createTerminal({ viewportY: 42, baseY: 100 })
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)
    markTerminalPinnedViewport(terminal)
    beginTerminalScrollIntentBufferRebuild(terminal)

    terminal.buffer.active.viewportY = 0
    terminal.buffer.active.baseY = 0
    const wheel = new Event('wheel') as WheelEvent
    Object.defineProperty(wheel, 'deltaY', { value: -10 })
    host.dispatchEvent(wheel)
    cancelTerminalScrollIntentBufferRebuildCompletions(terminal)
    endTerminalScrollIntentBufferRebuild(terminal)

    terminal.buffer.active.viewportY = 0
    terminal.buffer.active.baseY = 100
    enforceTerminalCurrentScrollIntent(terminal)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(42)
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
