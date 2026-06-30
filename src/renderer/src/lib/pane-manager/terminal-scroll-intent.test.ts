import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachTerminalScrollIntentTracking,
  captureTerminalWriteScrollIntent,
  enforceTerminalCurrentScrollIntent,
  enforceTerminalWriteScrollIntent,
  getTerminalScrollIntentKind,
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport,
  syncTerminalScrollIntentSoon
} from './terminal-scroll-intent'

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

class TestElement extends EventTarget {
  parentElement: TestElement | null = null
  readonly classList = {
    contains: (className: string): boolean => this.className.split(/\s+/).includes(className)
  }

  constructor(public className = '') {
    super()
  }

  append(child: TestElement): void {
    child.parentElement = this
  }

  closest(selector: string): TestElement | null {
    if (!selector.startsWith('.')) {
      return null
    }
    const className = selector.slice(1)
    if (this.classList.contains(className)) {
      return this
    }
    return this.parentElement?.closest(selector) ?? null
  }

  dispatchEvent(event: Event): boolean {
    if (!event.target) {
      Object.defineProperty(event, 'target', {
        configurable: true,
        value: this
      })
    }
    const result = super.dispatchEvent(event)
    if (event.bubbles && this.parentElement) {
      this.parentElement.dispatchEvent(event)
    }
    return result
  }
}

describe('terminal scroll intent', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('infers followOutput when the viewport is at the bottom', () => {
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })

    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
  })

  it('infers pinnedViewport when the viewport is above the bottom', () => {
    const terminal = createTerminal({ viewportY: 42, baseY: 100 })

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
  })

  it('preserves a pinned viewport after output moves xterm to bottom', () => {
    const terminal = createTerminal({ viewportY: 42, baseY: 100 })
    markTerminalPinnedViewport(terminal)
    const snapshot = captureTerminalWriteScrollIntent(terminal)

    terminal.buffer.active.baseY = 125
    terminal.buffer.active.viewportY = 125
    enforceTerminalWriteScrollIntent(terminal, snapshot)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(42)
    expect(terminal.buffer.active.viewportY).toBe(42)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
  })

  it('does not chase a stale absolute viewport down when scrollback trims at the cap on output writes', () => {
    // Repro: user pinned mid-scrollback while streaming output keeps the buffer
    // at its line cap. A top-of-scrollback prune renumbers ydisp downward so
    // xterm already holds the pinned content stable (viewportY drops by the
    // pruned count, baseY stays at the cap). The output-write enforce must not
    // scroll the viewport back down toward the live bottom.
    const terminal = createTerminal({ viewportY: 5000, baseY: 5000 })
    terminal.buffer.active.viewportY = 4900
    markTerminalPinnedViewport(terminal)
    const snapshot = captureTerminalWriteScrollIntent(terminal)

    // Buffer is full: prune renumbers content down by 3, baseY stays at cap.
    terminal.buffer.active.viewportY = 4897
    enforceTerminalWriteScrollIntent(terminal, snapshot, { fromOutputWrite: true })

    expect(terminal.scrollToLine).not.toHaveBeenCalled()
    expect(terminal.buffer.active.viewportY).toBe(4897)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
  })

  it('still re-pins downward drift from output auto-follow on output writes', () => {
    const terminal = createTerminal({ viewportY: 4900, baseY: 5000 })
    markTerminalPinnedViewport(terminal)
    const snapshot = captureTerminalWriteScrollIntent(terminal)

    // xterm auto-followed to bottom after the write; viewportY drifted above
    // the pinned line, so the pin must still be restored.
    terminal.buffer.active.viewportY = 5000
    enforceTerminalWriteScrollIntent(terminal, snapshot, { fromOutputWrite: true })

    expect(terminal.scrollToLine).toHaveBeenCalledWith(4900)
    expect(terminal.buffer.active.viewportY).toBe(4900)
  })

  it('follows output after output advances while following', () => {
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })
    markTerminalFollowOutput(terminal)
    const snapshot = captureTerminalWriteScrollIntent(terminal)

    terminal.buffer.active.baseY = 125
    terminal.buffer.active.viewportY = 0
    enforceTerminalWriteScrollIntent(terminal, snapshot)

    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(terminal.buffer.active.viewportY).toBe(125)
  })

  it('does not preserve across buffer type changes', () => {
    const terminal = createTerminal({ viewportY: 42, baseY: 100 })
    markTerminalPinnedViewport(terminal)
    const snapshot = captureTerminalWriteScrollIntent(terminal)

    terminal.buffer.active.type = 'alternate'
    terminal.buffer.active.viewportY = 0
    enforceTerminalWriteScrollIntent(terminal, snapshot)

    expect(terminal.scrollToLine).not.toHaveBeenCalled()
    expect(terminal.buffer.active.viewportY).toBe(0)
  })

  it('syncs intent from the current viewport after user scroll settles', () => {
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })

    terminal.buffer.active.viewportY = 50
    syncTerminalScrollIntentFromViewport(terminal)

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
  })

  it('tracks upward wheel immediately and records the settled viewport', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.stubGlobal('Element', TestElement)
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    const wheelUp = new Event('wheel') as WheelEvent
    Object.defineProperty(wheelUp, 'deltaY', { value: -10 })
    host.dispatchEvent(wheelUp)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')

    terminal.buffer.active.viewportY = 80
    await Promise.resolve()
    terminal.buffer.active.viewportY = 0
    enforceTerminalCurrentScrollIntent(terminal)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(80)
    disposable.dispose()
  })

  it('returns to followOutput after a downward wheel settles at the bottom', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.stubGlobal('Element', TestElement)
    const terminal = createTerminal({ viewportY: 50, baseY: 100 })
    const host = new TestElement() as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    const wheelDown = new Event('wheel') as WheelEvent
    Object.defineProperty(wheelDown, 'deltaY', { value: 10 })
    host.dispatchEvent(wheelDown)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')

    terminal.buffer.active.viewportY = 100
    await Promise.resolve()
    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')

    disposable.dispose()
  })

  it('keeps sampling briefly after wheel so delayed xterm scroll updates win', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.useFakeTimers()
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

  it('keeps a pane-keyed pinned viewport across a remounted empty terminal', () => {
    vi.stubGlobal('Element', TestElement)
    const firstTerminal = createTerminal({ viewportY: 76, baseY: 100 })
    const firstHost = new TestElement() as unknown as HTMLElement
    const firstDisposable = attachTerminalScrollIntentTracking(firstTerminal, firstHost, 'leaf-1')
    markTerminalPinnedViewport(firstTerminal)

    const remountedTerminal = createTerminal({ viewportY: 0, baseY: 0 })
    const remountedHost = new TestElement() as unknown as HTMLElement
    const remountedDisposable = attachTerminalScrollIntentTracking(
      remountedTerminal,
      remountedHost,
      'leaf-1'
    )

    syncTerminalScrollIntentFromViewport(remountedTerminal)
    remountedTerminal.buffer.active.baseY = 100
    remountedTerminal.buffer.active.viewportY = 100
    enforceTerminalCurrentScrollIntent(remountedTerminal)

    expect(remountedTerminal.scrollToLine).toHaveBeenCalledWith(76)
    expect(getTerminalScrollIntentKind(remountedTerminal)).toBe('pinnedViewport')

    firstDisposable.dispose()
    remountedDisposable.dispose()
  })

  it('tracks pointer-driven scrollbar scrolls without using output scroll as intent', () => {
    vi.stubGlobal('Element', TestElement)
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })
    const hostElement = new TestElement()
    const viewport = new TestElement('xterm-viewport')
    hostElement.append(viewport)
    const host = hostElement as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    terminal.buffer.active.viewportY = 50
    host.dispatchEvent(new Event('scroll'))
    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')

    viewport.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }))
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')

    disposable.dispose()
  })

  it('does not treat terminal body pointer activity as scrollbar intent', () => {
    vi.stubGlobal('Element', TestElement)
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })
    const hostElement = new TestElement()
    const body = new TestElement()
    hostElement.append(body)
    const host = hostElement as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host)

    body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    terminal.buffer.active.viewportY = 50
    host.dispatchEvent(new Event('scroll'))

    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
    disposable.dispose()
  })

  it('updates a manually pinned intent after xterm-handled keyboard scrolling settles', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })

    markTerminalPinnedViewport(terminal)
    terminal.buffer.active.viewportY = 75
    syncTerminalScrollIntentSoon(terminal)

    await Promise.resolve()
    terminal.buffer.active.viewportY = 0
    enforceTerminalCurrentScrollIntent(terminal)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(75)
  })

  it('enforces current intent once for visibility resume', () => {
    const terminal = createTerminal({ viewportY: 40, baseY: 100 })
    markTerminalPinnedViewport(terminal)

    terminal.buffer.active.viewportY = 0
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(40)
  })
})
