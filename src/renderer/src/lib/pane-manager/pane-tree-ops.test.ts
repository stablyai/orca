import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelPendingSafeFitContinuations, safeFit, safeFitAndThen } from './pane-tree-ops'
import type { ManagedPaneInternal } from './pane-manager-types'
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

// Why: markTerminalPinnedViewport registers its own anchor before fit registers the reflow marker.
function createPinAnchorMarker() {
  return { line: 42, isDisposed: false, dispose: vi.fn() }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function createPane({
  proposedCols,
  proposedRows,
  terminalCols,
  terminalRows
}: {
  proposedCols: number
  proposedRows: number
  terminalCols: number
  terminalRows: number
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
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: terminal as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fit reads only the supplied dataset and bounds.
    container: {
      dataset: {},
      getBoundingClientRect: () =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fit reads only these rectangle dimensions and edges.
        ({
          width: 800,
          height: 400,
          top: 0,
          left: 0,
          right: 800,
          bottom: 400
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
    imageAddon: null,
    ligaturesAddon: null,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

describe('safeFit', () => {
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
      .mockReturnValueOnce(createPinAnchorMarker())
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
    ;(pane.terminal as unknown as { registerMarker: unknown }).registerMarker = vi
      .fn()
      .mockReturnValueOnce(createPinAnchorMarker())
      .mockReturnValue(marker)
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
      .mockReturnValueOnce(createPinAnchorMarker())
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
