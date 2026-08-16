import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cancelPendingSafeFitContinuations,
  equalizePaneSplitSizes,
  safeFit,
  safeFitAndThen
} from './pane-tree-ops'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import { setFitOverride, hydrateOverrides } from './mobile-fit-overrides'
import {
  captureTerminalStructuralScrollIntent,
  enforceTerminalCurrentScrollIntent,
  markTerminalPinnedViewport,
  restoreTerminalStructuralScrollIntent
} from './terminal-scroll-intent'
import {
  beginTerminalScrollIntentBufferRebuild,
  cancelTerminalScrollIntentBufferRebuildCompletions,
  endTerminalScrollIntentBufferRebuild
} from './terminal-scroll-intent-rebuild'

class MockHTMLElement {
  classList: { contains: (cls: string) => boolean }
  children: MockHTMLElement[]
  style: Record<string, string>

  constructor(classes: string[], children: MockHTMLElement[] = [], flex = '') {
    this.classList = { contains: (cls: string) => classes.includes(cls) }
    this.children = children
    this.style = { flex }
  }
}

beforeAll(() => {
  ;(globalThis as unknown as Record<string, unknown>).HTMLElement = MockHTMLElement
})

afterEach(() => {
  hydrateOverrides([])
  vi.unstubAllGlobals()
})

function createPane({
  proposedCols,
  proposedRows,
  terminalCols,
  terminalRows,
  paneId = 1,
  containerWidth = 800,
  containerHeight = 400
}: {
  proposedCols: number
  proposedRows: number
  terminalCols: number
  terminalRows: number
  paneId?: number
  containerWidth?: number
  containerHeight?: number
}): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111' as never
  const fit = vi.fn()
  const proposeDimensions = vi.fn(() => ({ cols: proposedCols, rows: proposedRows }))
  const terminal = {
    cols: terminalCols,
    rows: terminalRows,
    element: {} as HTMLElement,
    resize: vi.fn((cols: number, rows: number) => {
      terminal.cols = cols
      terminal.rows = rows
    }),
    refresh: vi.fn(),
    buffer: {
      active: {
        type: 'normal',
        viewportY: 0,
        baseY: 0,
        getLine: vi.fn(() => ({ translateToString: () => '' }))
      }
    },
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn((line: number) => {
      terminal.buffer.active.viewportY = line
    }),
    scrollLines: vi.fn((delta: number) => {
      terminal.buffer.active.viewportY = Math.max(
        0,
        Math.min(terminal.buffer.active.baseY, terminal.buffer.active.viewportY + delta)
      )
    })
  }

  return {
    id: paneId,
    leafId,
    stablePaneId: leafId,
    terminal: terminal as never,
    container: {
      dataset: {},
      getBoundingClientRect: () =>
        ({
          width: containerWidth,
          height: containerHeight,
          top: 0,
          left: 0,
          right: containerWidth,
          bottom: containerHeight
        }) as DOMRect
    } as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    fitAddon: {
      fit,
      proposeDimensions
    } as never,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    webglAddon: null,
    ligaturesAddon: null,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

describe('safeFit', () => {
  it('skips drag-frame refits when the pane grid dimensions did not change', () => {
    const pane = createPane({
      proposedCols: 120,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })

    safeFit(pane)

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
  })

  it('does not restore scroll for no-op drag-frame refits', () => {
    const pane = createPane({
      proposedCols: 120,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    const activeBuffer = pane.terminal.buffer.active as { viewportY: number; baseY: number }
    activeBuffer.viewportY = 42
    activeBuffer.baseY = 100

    safeFit(pane)

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(pane.terminal.scrollToLine).not.toHaveBeenCalled()
    expect(pane.terminal.scrollToBottom).not.toHaveBeenCalled()
    expect(pane.terminal.scrollLines).not.toHaveBeenCalled()
    expect(activeBuffer.viewportY).toBe(42)
  })

  it('skips refits while the pane container is still near-zero width', () => {
    const pane = createPane({
      proposedCols: 2,
      proposedRows: 24,
      terminalCols: 120,
      terminalRows: 32,
      containerWidth: 8,
      containerHeight: 400
    })

    safeFit(pane)

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(pane.terminal.resize).not.toHaveBeenCalled()
    expect(pane.terminal.cols).toBe(120)
  })

  it('still refits when the proposed grid dimensions changed', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('coalesces fits until replay parsing and scroll restoration complete', async () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    const activeBuffer = pane.terminal.buffer.active as { viewportY: number; baseY: number }
    activeBuffer.viewportY = 80
    activeBuffer.baseY = 100
    markTerminalPinnedViewport(pane.terminal)
    const intent = captureTerminalStructuralScrollIntent(pane.terminal)
    beginTerminalScrollIntentBufferRebuild(pane.terminal)
    activeBuffer.viewportY = 0
    activeBuffer.baseY = 0

    safeFit(pane)
    safeFit(pane)
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()

    activeBuffer.viewportY = 200
    activeBuffer.baseY = 200
    vi.mocked(pane.fitAddon.fit).mockImplementation(() => {
      expect(activeBuffer.viewportY).toBe(180)
    })
    endTerminalScrollIntentBufferRebuild(pane.terminal)
    restoreTerminalStructuralScrollIntent(pane.terminal, intent, { restoreBy: 'bottomOffset' })
    await Promise.resolve()

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('drops a deferred fit when a replay rebuild is canceled', async () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    beginTerminalScrollIntentBufferRebuild(pane.terminal)
    safeFit(pane)
    cancelTerminalScrollIntentBufferRebuildCompletions(pane.terminal)
    endTerminalScrollIntentBufferRebuild(pane.terminal)
    await Promise.resolve()

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
  })

  it('restores the viewport if fit clobbers it during resize', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    const activeBuffer = pane.terminal.buffer.active as { viewportY: number; baseY: number }
    activeBuffer.viewportY = 42
    activeBuffer.baseY = 100
    vi.mocked(pane.fitAddon.fit).mockImplementation(() => {
      activeBuffer.viewportY = 0
    })

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.scrollToLine).toHaveBeenCalledWith(42)
    expect(activeBuffer.viewportY).toBe(42)
  })

  it('restores pinned content via marker when fit reflow renumbers buffer lines', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    const activeBuffer = pane.terminal.buffer.active as {
      viewportY: number
      baseY: number
      cursorY?: number
    }
    activeBuffer.viewportY = 42
    activeBuffer.baseY = 100
    activeBuffer.cursorY = 0
    const marker = { line: 42, isDisposed: false, dispose: vi.fn() }
    ;(pane.terminal as unknown as { registerMarker: unknown }).registerMarker = vi.fn(() => marker)
    vi.mocked(pane.fitAddon.fit).mockImplementation(() => {
      // Reflow at narrower cols rewraps lines; the tracked content now lives
      // at a different absolute line than the pre-fit viewport number.
      activeBuffer.baseY = 130
      activeBuffer.viewportY = 0
      marker.line = 57
    })

    safeFit(pane)

    expect(pane.terminal.scrollToLine).toHaveBeenCalledWith(57)
    expect(activeBuffer.viewportY).toBe(57)
    expect(marker.dispose).toHaveBeenCalled()
  })

  it('records the restored post-reflow pin when widening lowers baseY', () => {
    const pane = createPane({
      proposedCols: 160,
      proposedRows: 32,
      terminalCols: 80,
      terminalRows: 32
    })
    const activeBuffer = pane.terminal.buffer.active as {
      viewportY: number
      baseY: number
      cursorY?: number
    }
    activeBuffer.viewportY = 42
    activeBuffer.baseY = 100
    activeBuffer.cursorY = 0
    const marker = { line: 42, isDisposed: false, dispose: vi.fn() }
    ;(pane.terminal as unknown as { registerMarker: unknown }).registerMarker = vi.fn(() => marker)
    markTerminalPinnedViewport(pane.terminal)
    vi.mocked(pane.fitAddon.fit).mockImplementation(() => {
      activeBuffer.baseY = 70
      activeBuffer.viewportY = 0
      marker.line = 30
    })

    safeFit(pane)
    activeBuffer.viewportY = 0
    vi.mocked(pane.terminal.scrollToLine).mockClear()
    enforceTerminalCurrentScrollIntent(pane.terminal)

    expect(pane.terminal.scrollToLine).toHaveBeenLastCalledWith(30)
  })

  it('preserves a durable pin when the remounted fit buffer is still empty', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 80,
      terminalRows: 24
    })
    const activeBuffer = pane.terminal.buffer.active as {
      viewportY: number
      baseY: number
      cursorY?: number
    }
    activeBuffer.viewportY = 42
    activeBuffer.baseY = 100
    activeBuffer.cursorY = 0
    markTerminalPinnedViewport(pane.terminal)

    activeBuffer.viewportY = 0
    activeBuffer.baseY = 0
    safeFit(pane)

    activeBuffer.viewportY = 0
    activeBuffer.baseY = 80
    vi.mocked(pane.terminal.scrollToLine).mockClear()
    enforceTerminalCurrentScrollIntent(pane.terminal)
    expect(pane.terminal.scrollToLine).toHaveBeenLastCalledWith(22)
  })

  it('keeps a follow-output pane at the bottom through fit', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    const activeBuffer = pane.terminal.buffer.active as { viewportY: number; baseY: number }
    activeBuffer.viewportY = 100
    activeBuffer.baseY = 100
    vi.mocked(pane.fitAddon.fit).mockImplementation(() => {
      activeBuffer.baseY = 130
      activeBuffer.viewportY = 0
    })

    safeFit(pane)

    expect(pane.terminal.scrollToBottom).toHaveBeenCalled()
  })

  it('retries a transient dimensions failure before recording the post-fit pin', () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    const activeBuffer = pane.terminal.buffer.active as {
      viewportY: number
      baseY: number
      cursorY?: number
    }
    activeBuffer.viewportY = 42
    activeBuffer.baseY = 100
    activeBuffer.cursorY = 0
    const marker = { line: 42, isDisposed: false, dispose: vi.fn() }
    ;(pane.terminal as unknown as { registerMarker: unknown }).registerMarker = vi.fn(() => marker)
    markTerminalPinnedViewport(pane.terminal)
    vi.mocked(pane.fitAddon.fit).mockImplementation(() => {
      activeBuffer.baseY = 70
      activeBuffer.viewportY = 0
      marker.line = 30
    })
    vi.mocked(pane.terminal.scrollToLine)
      .mockImplementationOnce(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })
      .mockImplementation((line: number) => {
        activeBuffer.viewportY = line
      })

    expect(() => safeFit(pane)).not.toThrow()
    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(activeBuffer.viewportY).toBe(0)
    expect(marker.dispose).not.toHaveBeenCalled()

    frameCallbacks.shift()?.(0)
    expect(activeBuffer.viewportY).toBe(30)
    expect(marker.dispose).toHaveBeenCalled()

    activeBuffer.viewportY = 0
    vi.mocked(pane.terminal.scrollToLine).mockClear()
    enforceTerminalCurrentScrollIntent(pane.terminal)
    expect(pane.terminal.scrollToLine).toHaveBeenLastCalledWith(30)
  })

  it('cancels a pending fit retry when snapshot replay starts', () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    const activeBuffer = pane.terminal.buffer.active as {
      viewportY: number
      baseY: number
      cursorY?: number
    }
    activeBuffer.viewportY = 42
    activeBuffer.baseY = 100
    activeBuffer.cursorY = 0
    const marker = { line: 30, isDisposed: false, dispose: vi.fn() }
    ;(pane.terminal as unknown as { registerMarker: unknown }).registerMarker = vi.fn(() => marker)
    markTerminalPinnedViewport(pane.terminal)
    vi.mocked(pane.fitAddon.fit).mockImplementation(() => {
      activeBuffer.baseY = 70
      activeBuffer.viewportY = 0
    })
    vi.mocked(pane.terminal.scrollToLine).mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    })

    safeFit(pane)
    beginTerminalScrollIntentBufferRebuild(pane.terminal)
    frameCallbacks.shift()?.(0)

    expect(pane.terminal.scrollToLine).toHaveBeenCalledTimes(1)
    expect(marker.dispose).toHaveBeenCalledTimes(1)
    endTerminalScrollIntentBufferRebuild(pane.terminal)
  })

  it('carries the original fit marker across another fit before retry', () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    const activeBuffer = pane.terminal.buffer.active as {
      viewportY: number
      baseY: number
      cursorY?: number
    }
    activeBuffer.viewportY = 42
    activeBuffer.baseY = 100
    activeBuffer.cursorY = 0
    const originalMarker = { line: 30, isDisposed: false, dispose: vi.fn() }
    const replacementMarker = { line: 5, isDisposed: false, dispose: vi.fn() }
    ;(pane.terminal as unknown as { registerMarker: unknown }).registerMarker = vi
      .fn()
      .mockReturnValueOnce(originalMarker)
      .mockReturnValueOnce(replacementMarker)
    vi.mocked(pane.fitAddon.fit).mockImplementation(() => {
      activeBuffer.baseY = 70
      activeBuffer.viewportY = 0
    })
    vi.mocked(pane.terminal.scrollToLine)
      .mockImplementationOnce(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })
      .mockImplementation((line: number) => {
        activeBuffer.viewportY = line
      })
    markTerminalPinnedViewport(pane.terminal)

    safeFit(pane)
    safeFit(pane)

    expect(activeBuffer.viewportY).toBe(30)
    expect(originalMarker.dispose).toHaveBeenCalledTimes(1)
    expect(replacementMarker.dispose).toHaveBeenCalledTimes(1)
    expect(frameCallbacks).toHaveLength(1)
  })

  it('resumes an exhausted dimensions retry on a same-grid reveal fit', () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    const activeBuffer = pane.terminal.buffer.active as {
      viewportY: number
      baseY: number
      cursorY?: number
    }
    activeBuffer.viewportY = 42
    activeBuffer.baseY = 100
    activeBuffer.cursorY = 0
    const marker = { line: 30, isDisposed: false, dispose: vi.fn() }
    ;(pane.terminal as unknown as { registerMarker: unknown }).registerMarker = vi.fn(() => marker)
    vi.mocked(pane.fitAddon.fit).mockImplementation(() => {
      activeBuffer.baseY = 70
      activeBuffer.viewportY = 0
    })
    vi.mocked(pane.terminal.scrollToLine).mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    })
    markTerminalPinnedViewport(pane.terminal)

    safeFit(pane)
    frameCallbacks.shift()?.(0)
    frameCallbacks.shift()?.(0)
    expect(marker.dispose).not.toHaveBeenCalled()

    vi.mocked(pane.terminal.scrollToLine).mockImplementation((line: number) => {
      activeBuffer.viewportY = line
    })
    ;(pane.terminal as unknown as { cols: number }).cols = 100
    safeFit(pane)
    expect(activeBuffer.viewportY).toBe(30)
    expect(marker.dispose).toHaveBeenCalledTimes(1)
  })

  it('releases a replacement marker when a resumed retry throws', () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    const activeBuffer = pane.terminal.buffer.active as {
      viewportY: number
      baseY: number
      cursorY?: number
    }
    activeBuffer.viewportY = 42
    activeBuffer.baseY = 100
    activeBuffer.cursorY = 0
    const originalMarker = { line: 30, isDisposed: false, dispose: vi.fn() }
    const replacementMarker = { line: 5, isDisposed: false, dispose: vi.fn() }
    ;(pane.terminal as unknown as { registerMarker: unknown }).registerMarker = vi
      .fn()
      .mockReturnValueOnce(originalMarker)
      .mockReturnValueOnce(replacementMarker)
    vi.mocked(pane.fitAddon.fit).mockImplementation(() => {
      activeBuffer.baseY = 70
      activeBuffer.viewportY = 0
    })
    vi.mocked(pane.terminal.scrollToLine)
      .mockImplementationOnce(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })
      .mockImplementationOnce(() => {
        throw new Error('unexpected resumed restore failure')
      })
    markTerminalPinnedViewport(pane.terminal)

    safeFit(pane)
    expect(() => safeFit(pane)).not.toThrow()

    expect(originalMarker.dispose).toHaveBeenCalledTimes(1)
    expect(replacementMarker.dispose).toHaveBeenCalledTimes(1)
  })

  it('still refits when a split-scroll lock is active and the grid changed', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    pane.pendingSplitScrollState = {
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 0,
      baseY: 0
    } satisfies ScrollState

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('resizes terminal to override dimensions when mobile-fit override is active', () => {
    const pane = createPane({
      proposedCols: 120,
      proposedRows: 40,
      terminalCols: 120,
      terminalRows: 40
    })
    pane.container.dataset.ptyId = 'pty-phone'
    setFitOverride('pty-phone', 'mobile-fit', 49, 20)

    safeFit(pane)

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(pane.terminal.resize).toHaveBeenCalledWith(49, 20)
  })

  it('parks xterm at a remote desktop owner grid', () => {
    const pane = createPane({
      proposedCols: 120,
      proposedRows: 40,
      terminalCols: 120,
      terminalRows: 40
    })
    pane.container.dataset.ptyId = 'pty-remote'
    setFitOverride('pty-remote', 'remote-desktop-fit', 96, 32)

    safeFit(pane)

    expect(pane.terminal.resize).toHaveBeenCalledWith(96, 32)
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
  })

  it('skips resize when terminal already matches override dimensions', () => {
    const pane = createPane({
      proposedCols: 120,
      proposedRows: 40,
      terminalCols: 49,
      terminalRows: 20
    })
    pane.container.dataset.ptyId = 'pty-phone'
    setFitOverride('pty-phone', 'mobile-fit', 49, 20)

    safeFit(pane)

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(pane.terminal.resize).not.toHaveBeenCalled()
  })

  it('does not apply override when pane has no data-pty-id', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    setFitOverride('pty-phone', 'mobile-fit', 49, 20)

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.resize).not.toHaveBeenCalled()
  })

  it('falls through to normal fit when override is cleared', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 49,
      terminalRows: 20
    })
    pane.container.dataset.ptyId = 'pty-phone'
    setFitOverride('pty-phone', 'mobile-fit', 49, 20)
    setFitOverride('pty-phone', 'desktop-fit', 120, 40)

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('does not cross-contaminate overrides between different ptyIds', () => {
    const paneA = createPane({
      proposedCols: 120,
      proposedRows: 40,
      terminalCols: 120,
      terminalRows: 40,
      paneId: 1
    })
    paneA.container.dataset.ptyId = 'pty-A'

    const paneB = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 40,
      paneId: 2
    })
    paneB.container.dataset.ptyId = 'pty-B'

    setFitOverride('pty-A', 'mobile-fit', 49, 20)

    safeFit(paneA)
    safeFit(paneB)

    expect(paneA.terminal.resize).toHaveBeenCalledWith(49, 20)
    expect(paneA.fitAddon.fit).not.toHaveBeenCalled()
    expect(paneB.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(paneB.terminal.resize).not.toHaveBeenCalled()
  })

  it('runs an authoritative continuation only after a deferred replay fit', async () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 80,
      terminalRows: 24
    })
    vi.mocked(pane.fitAddon.fit).mockImplementation(() => {
      pane.terminal.resize(100, 32)
    })
    const observedDimensions: { cols: number; rows: number }[] = []
    beginTerminalScrollIntentBufferRebuild(pane.terminal)

    safeFitAndThen(pane, 'pty-resize', () => {
      observedDimensions.push({ cols: pane.terminal.cols, rows: pane.terminal.rows })
    })

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(observedDimensions).toEqual([])
    endTerminalScrollIntentBufferRebuild(pane.terminal)
    await Promise.resolve()

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(observedDimensions).toEqual([{ cols: 100, rows: 32 }])
  })

  it('retains an authoritative continuation until a later measurable fit succeeds', async () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 80,
      terminalRows: 24
    })
    vi.mocked(pane.fitAddon.proposeDimensions).mockReturnValue(undefined)
    const continuation = vi.fn()

    const pending = safeFitAndThen(pane, 'pty-resize', continuation)

    expect(continuation).not.toHaveBeenCalled()
    vi.mocked(pane.fitAddon.proposeDimensions).mockReturnValue({ cols: 100, rows: 32 })
    safeFit(pane)

    await expect(pending.completion).resolves.toBe(true)
    expect(continuation).toHaveBeenCalledTimes(1)
  })

  it('cancels an authoritative fit continuation disposed before its post-replay microtask', async () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 80,
      terminalRows: 24
    })
    const continuation = vi.fn()
    beginTerminalScrollIntentBufferRebuild(pane.terminal)
    const pending = safeFitAndThen(pane, 'pty-resize', continuation)

    endTerminalScrollIntentBufferRebuild(pane.terminal)
    cancelTerminalScrollIntentBufferRebuildCompletions(pane.terminal)
    cancelPendingSafeFitContinuations(pane)
    await Promise.resolve()

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(continuation).not.toHaveBeenCalled()
    await expect(pending.completion).resolves.toBe(false)
  })
})

describe('equalizePaneSplitSizes', () => {
  const pane = (flex = '1 1 0%'): MockHTMLElement => new MockHTMLElement(['pane'], [], flex)
  const split = (
    direction: 'vertical' | 'horizontal',
    children: MockHTMLElement[],
    flex = '1 1 0%'
  ): MockHTMLElement =>
    new MockHTMLElement(
      ['pane-split', direction === 'vertical' ? 'is-vertical' : 'is-horizontal'],
      children,
      flex
    )

  it('weights nested same-axis splits so same-axis panes equalize evenly', () => {
    const left = pane('10 1 0%')
    const middle = pane('20 1 0%')
    const right = pane('30 1 0%')
    const rightSplit = split('vertical', [middle, right], '90 1 0%')
    const root = split('vertical', [left, rightSplit])

    expect(equalizePaneSplitSizes(root as unknown as HTMLElement)).toBe(true)

    expect(left.style.flex).toBe('1 1 0%')
    expect(rightSplit.style.flex).toBe('2 1 0%')
    expect(middle.style.flex).toBe('1 1 0%')
    expect(right.style.flex).toBe('1 1 0%')
  })

  it('treats perpendicular child splits as one weighted region', () => {
    const top = pane('7 1 0%')
    const bottom = pane('3 1 0%')
    const leftStack = split('horizontal', [top, bottom], '15 1 0%')
    const right = pane('85 1 0%')
    const root = split('vertical', [leftStack, right])

    expect(equalizePaneSplitSizes(root as unknown as HTMLElement)).toBe(true)

    expect(leftStack.style.flex).toBe('1 1 0%')
    expect(right.style.flex).toBe('1 1 0%')
    expect(top.style.flex).toBe('1 1 0%')
    expect(bottom.style.flex).toBe('1 1 0%')
  })

  it('returns false when there is no split tree to change', () => {
    expect(equalizePaneSplitSizes(pane() as unknown as HTMLElement)).toBe(false)
    expect(equalizePaneSplitSizes(null)).toBe(false)
  })
})
