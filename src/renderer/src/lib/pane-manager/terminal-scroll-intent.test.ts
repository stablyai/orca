import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindTerminalScrollIntentKey,
  captureTerminalStructuralScrollIntent,
  enforceTerminalCurrentScrollIntent,
  getTerminalScrollIntentKind,
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport,
  restoreTerminalStructuralScrollIntent
} from './terminal-scroll-intent'
import { syncTerminalScrollIntentSoon } from './terminal-scroll-intent-settle'
import { clearTerminalScrollbackAndFollowOutput } from './terminal-scrollback-clear'
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
    for (const candidate of selector.split(',')) {
      const trimmed = candidate.trim()
      if (!trimmed.startsWith('.')) {
        continue
      }
      const className = trimmed.slice(1)
      if (this.classList.contains(className)) {
        return this
      }
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

  it('treats a viewport exactly one row above bottom as pinned', () => {
    const terminal = createTerminal({ viewportY: 99, baseY: 100 })

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
    syncTerminalScrollIntentFromViewport(terminal)
    expect(captureTerminalStructuralScrollIntent(terminal)?.kind).toBe('pinnedViewport')
  })

  it('clears a pinned scrollback into follow-output state', () => {
    const terminal = {
      ...createTerminal({ viewportY: 42, baseY: 100 }),
      clear: vi.fn()
    }
    markTerminalPinnedViewport(terminal)

    clearTerminalScrollbackAndFollowOutput(terminal)

    expect(terminal.clear).toHaveBeenCalledOnce()
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce()
    expect(terminal.clear.mock.invocationCallOrder[0]).toBeLessThan(
      terminal.scrollToBottom.mock.invocationCallOrder[0]
    )
    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
  })

  it('preserves a pinned viewport after output moves xterm to bottom', () => {
    const terminal = createTerminal({ viewportY: 42, baseY: 100 })
    markTerminalPinnedViewport(terminal)
    const snapshot = captureTerminalStructuralScrollIntent(terminal)

    terminal.buffer.active.baseY = 125
    terminal.buffer.active.viewportY = 125
    restoreTerminalStructuralScrollIntent(terminal, snapshot)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(42)
    expect(terminal.buffer.active.viewportY).toBe(42)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
  })

  it('follows output after output advances while following', () => {
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })
    markTerminalFollowOutput(terminal)
    const snapshot = captureTerminalStructuralScrollIntent(terminal)

    terminal.buffer.active.baseY = 125
    terminal.buffer.active.viewportY = 0
    restoreTerminalStructuralScrollIntent(terminal, snapshot)

    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(terminal.buffer.active.viewportY).toBe(125)
  })

  it('does not preserve across buffer type changes', () => {
    const terminal = createTerminal({ viewportY: 42, baseY: 100 })
    markTerminalPinnedViewport(terminal)
    const snapshot = captureTerminalStructuralScrollIntent(terminal)

    terminal.buffer.active.type = 'alternate'
    terminal.buffer.active.viewportY = 0
    restoreTerminalStructuralScrollIntent(terminal, snapshot)

    expect(terminal.scrollToLine).not.toHaveBeenCalled()
    expect(terminal.buffer.active.viewportY).toBe(0)
  })

  it('does not enforce a captured intent after newer user intent supersedes it', () => {
    const terminal = createTerminal({ viewportY: 42, baseY: 100 })
    markTerminalPinnedViewport(terminal)
    const staleSnapshot = captureTerminalStructuralScrollIntent(terminal)

    terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    markTerminalFollowOutput(terminal)
    terminal.buffer.active.baseY = 125
    restoreTerminalStructuralScrollIntent(terminal, staleSnapshot)

    expect(terminal.scrollToLine).not.toHaveBeenCalled()
    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
  })

  it('syncs intent from the current viewport after user scroll settles', () => {
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })

    terminal.buffer.active.viewportY = 50
    syncTerminalScrollIntentFromViewport(terminal)

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
  })

  it('records xterm native scrollback-trim movement before structural enforcement', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 20 })
    markTerminalPinnedViewport(terminal)

    // At scrollback capacity xterm keeps baseY fixed and walks viewportY up
    // as old rows trim, preserving the visible content without app help.
    terminal.buffer.active.viewportY = 5
    syncTerminalScrollIntentFromViewport(terminal)
    terminal.buffer.active.viewportY = 0
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(5)
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

  it('captures durable pinned coordinates before replaying into an empty remount', () => {
    vi.stubGlobal('Element', TestElement)
    const firstTerminal = createTerminal({ viewportY: 76, baseY: 100 })
    const firstHost = new TestElement() as unknown as HTMLElement
    const firstDisposable = attachTerminalScrollIntentTracking(
      firstTerminal,
      firstHost,
      'leaf-remount-replay'
    )
    markTerminalPinnedViewport(firstTerminal)

    const remountedTerminal = createTerminal({ viewportY: 0, baseY: 0 })
    const remountedHost = new TestElement() as unknown as HTMLElement
    const remountedDisposable = attachTerminalScrollIntentTracking(
      remountedTerminal,
      remountedHost,
      'leaf-remount-replay'
    )
    const intent = captureTerminalStructuralScrollIntent(remountedTerminal)

    expect(intent).toMatchObject({
      kind: 'pinnedViewport',
      viewportY: 76,
      baseY: 100
    })
    remountedTerminal.buffer.active.viewportY = 100
    remountedTerminal.buffer.active.baseY = 100
    restoreTerminalStructuralScrollIntent(remountedTerminal, intent, {
      restoreBy: 'bottomOffset'
    })

    expect(remountedTerminal.scrollToLine).toHaveBeenLastCalledWith(76)
    expect(remountedTerminal.buffer.active.viewportY).toBe(76)
    firstDisposable.dispose()
    remountedDisposable.dispose()
  })

  it('refreshes pinned base geometry before a keyed empty remount', () => {
    vi.stubGlobal('Element', TestElement)
    const firstTerminal = createTerminal({ viewportY: 10, baseY: 20 })
    const firstHost = new TestElement() as unknown as HTMLElement
    const firstDisposable = attachTerminalScrollIntentTracking(
      firstTerminal,
      firstHost,
      'leaf-growing-pin'
    )
    markTerminalPinnedViewport(firstTerminal)

    firstTerminal.buffer.active.baseY = 30
    syncTerminalScrollIntentFromViewport(firstTerminal)
    const remountedTerminal = createTerminal({ viewportY: 0, baseY: 0 })
    const remountedHost = new TestElement() as unknown as HTMLElement
    const remountedDisposable = attachTerminalScrollIntentTracking(
      remountedTerminal,
      remountedHost,
      'leaf-growing-pin'
    )
    const intent = captureTerminalStructuralScrollIntent(remountedTerminal)
    remountedTerminal.buffer.active.viewportY = 30
    remountedTerminal.buffer.active.baseY = 30
    restoreTerminalStructuralScrollIntent(remountedTerminal, intent, {
      restoreBy: 'bottomOffset'
    })

    expect(intent).toMatchObject({ viewportY: 10, baseY: 30 })
    expect(remountedTerminal.scrollToLine).toHaveBeenLastCalledWith(10)
    firstDisposable.dispose()
    remountedDisposable.dispose()
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

  it.each(['xterm-scrollbar', 'xterm-slider'])(
    'tracks pointer-driven xterm %s scrolls as user intent',
    (scrollbarClassName) => {
      vi.stubGlobal('Element', TestElement)
      const terminal = createTerminal({ viewportY: 100, baseY: 100 })
      const hostElement = new TestElement()
      const scrollbarTarget = new TestElement(scrollbarClassName)
      const scrollbarChild = new TestElement('xterm-scrollbar-child')
      hostElement.append(scrollbarTarget)
      scrollbarTarget.append(scrollbarChild)
      const host = hostElement as unknown as HTMLElement
      const disposable = attachTerminalScrollIntentTracking(terminal, host)

      terminal.buffer.active.viewportY = 50
      host.dispatchEvent(new Event('scroll'))
      expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')

      scrollbarChild.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      scrollbarChild.dispatchEvent(new Event('scroll', { bubbles: true }))
      expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')

      disposable.dispose()
    }
  )

  it('restores a scrollbar-dragged viewport instead of stale top intent', () => {
    vi.stubGlobal('Element', TestElement)
    const terminal = createTerminal({ viewportY: 0, baseY: 600 })
    const hostElement = new TestElement()
    const scrollbar = new TestElement('xterm-scrollbar')
    const slider = new TestElement('xterm-slider')
    hostElement.append(scrollbar)
    scrollbar.append(slider)
    const host = hostElement as unknown as HTMLElement
    const disposable = attachTerminalScrollIntentTracking(terminal, host, 'terminal-1')

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')

    terminal.buffer.active.viewportY = 572
    slider.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    slider.dispatchEvent(new Event('scroll', { bubbles: true }))

    terminal.buffer.active.viewportY = 0
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(572)
    expect(terminal.buffer.active.viewportY).toBe(572)
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

  it('enforces current intent once for visibility resume', () => {
    const terminal = createTerminal({ viewportY: 40, baseY: 100 })
    markTerminalPinnedViewport(terminal)

    terminal.buffer.active.viewportY = 0
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(40)
  })

  it('reverts a wheel pin to followOutput when the viewport never leaves the bottom', async () => {
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

    // A sub-row trackpad delta or a wheel consumed by a mouse-reporting TUI:
    // the wheel event fires but xterm's viewport never moves.
    const wheelUp = new Event('wheel') as WheelEvent
    Object.defineProperty(wheelUp, 'deltaY', { value: -2 })
    host.dispatchEvent(wheelUp)
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')

    await Promise.resolve()
    while (frameCallbacks.length) {
      frameCallbacks.shift()?.(16)
    }
    vi.advanceTimersByTime(80)

    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
    disposable.dispose()
  })

  it('keeps a wheel pin when the viewport leaves the bottom before settle', async () => {
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

    terminal.buffer.active.viewportY = 60
    await Promise.resolve()
    while (frameCallbacks.length) {
      frameCallbacks.shift()?.(16)
    }
    vi.advanceTimersByTime(80)

    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
    terminal.buffer.active.viewportY = 0
    enforceTerminalCurrentScrollIntent(terminal)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(60)
    disposable.dispose()
  })

  it('does not freeze the viewport when a pinned intent is latched at the bottom', () => {
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })
    // Phantom pin: a wheel/PageUp the viewport never followed latched
    // pinnedViewport while the terminal was still at the bottom.
    markTerminalPinnedViewport(terminal)

    for (let batch = 1; batch <= 2; batch += 1) {
      const snapshot = captureTerminalStructuralScrollIntent(terminal)
      // xterm follows output during the write because the viewport was at bottom.
      terminal.buffer.active.baseY += 25
      terminal.buffer.active.viewportY = terminal.buffer.active.baseY
      restoreTerminalStructuralScrollIntent(terminal, snapshot)
      expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
    }
    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
  })

  it('resumes following on visibility enforce when the stored pin was recorded at the bottom', () => {
    const terminal = createTerminal({ viewportY: 100, baseY: 100 })
    markTerminalPinnedViewport(terminal)

    terminal.buffer.active.baseY = 400
    terminal.buffer.active.viewportY = 100
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.scrollToBottom).toHaveBeenCalled()
    expect(terminal.buffer.active.viewportY).toBe(400)
    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
  })

  it('restores a pinned viewport by bottom offset after a rebuild shrinks the scrollback', () => {
    const terminal = createTerminal({ viewportY: 550, baseY: 600 })
    markTerminalPinnedViewport(terminal)

    // Snapshot replay rebuilds a shorter, renumbered buffer.
    terminal.buffer.active.baseY = 200
    terminal.buffer.active.viewportY = 200
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(150)
    expect(terminal.buffer.active.viewportY).toBe(150)
  })

  it('does not re-latch a pinned intent from a transiently shorter rebuilt buffer', () => {
    const terminal = createTerminal({ viewportY: 248, baseY: 254 })
    markTerminalPinnedViewport(terminal)
    const snapshot = captureTerminalStructuralScrollIntent(terminal)

    // Snapshot replay cleared the buffer; enforcement races the async parse.
    terminal.buffer.active.baseY = 0
    terminal.buffer.active.viewportY = 0
    restoreTerminalStructuralScrollIntent(terminal, snapshot)

    // The replay finishes parsing and the scrollback regrows past the pin.
    terminal.buffer.active.baseY = 284
    terminal.buffer.active.viewportY = 284
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(248)
    expect(terminal.buffer.active.viewportY).toBe(248)
  })

  it('keeps a pinned intent when capture races a cleared unparsed buffer', () => {
    const terminal = createTerminal({ viewportY: 248, baseY: 254 })
    markTerminalPinnedViewport(terminal)

    // A structural capture sees the rebuilt buffer while it is still empty;
    // the at-bottom(0/0) reading is transient and must not convert the pin.
    terminal.buffer.active.baseY = 0
    terminal.buffer.active.viewportY = 0
    const snapshot = captureTerminalStructuralScrollIntent(terminal)
    expect(snapshot?.kind).toBe('pinnedViewport')
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

    // A live streaming batch lands while the replay is partially parsed.
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
