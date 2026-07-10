import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { schedulePaneRevealPresent, schedulePaneRevealRepaint } from './pane-reveal-repaint'
import { resetTerminalWebglSuggestion } from './pane-webgl-renderer'

type FakeWebglAddon = { clearTextureAtlas: ReturnType<typeof vi.fn> }

function createPane(options: { webglAddon?: FakeWebglAddon | null } = {}): ManagedPaneInternal {
  const leafId = '33333333-3333-4333-8333-333333333333' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: {
      cols: 80,
      rows: 24,
      refresh: vi.fn(),
      loadAddon: vi.fn()
    } as never,
    container: {} as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'on',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: (options.webglAddon ?? null) as never,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    pendingWebglRefreshRafId: null,
    fitAddon: {
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 23 })),
      fit: vi.fn()
    } as never,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

describe('schedulePaneRevealRepaint', () => {
  let rafQueue: FrameRequestCallback[]

  function flushFrame(): void {
    const queue = rafQueue
    rafQueue = []
    for (const callback of queue) {
      callback(16)
    }
  }

  beforeEach(() => {
    resetTerminalWebglSuggestion()
    rafQueue = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafQueue.push(callback)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('repaints only after the post-reveal frame has settled', () => {
    const webglAddon = { clearTextureAtlas: vi.fn() }
    const pane = createPane({ webglAddon })
    schedulePaneRevealRepaint(() => [pane])

    // First frame: reveal layout may still be in flight; redraw requests fired
    // here can be dropped by the renderer without retry.
    flushFrame()
    expect(webglAddon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(pane.terminal.refresh).not.toHaveBeenCalled()

    flushFrame()
    expect(webglAddon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('reattaches a missing WebGL addon before repainting', () => {
    const pane = createPane()
    schedulePaneRevealRepaint(() => [pane])

    flushFrame()
    flushFrame()

    expect(pane.webglAddon).not.toBeNull()
    expect(pane.terminal.refresh).toHaveBeenCalled()
  })

  it('resolves the pane list at repaint time, not at scheduling time', () => {
    const stalePane = createPane({ webglAddon: { clearTextureAtlas: vi.fn() } })
    const livePane = createPane({ webglAddon: { clearTextureAtlas: vi.fn() } })
    const panes = [stalePane]
    schedulePaneRevealRepaint(() => panes)
    panes.splice(0, panes.length, livePane)

    flushFrame()
    flushFrame()

    expect(
      (stalePane.webglAddon as never as FakeWebglAddon).clearTextureAtlas
    ).not.toHaveBeenCalled()
    expect(
      (livePane.webglAddon as never as FakeWebglAddon).clearTextureAtlas
    ).toHaveBeenCalledTimes(1)
  })

  it('keeps repainting remaining panes when one pane throws', () => {
    const explosivePane = {
      get gpuRenderingEnabled(): boolean {
        throw new Error('pane torn down mid-frame')
      }
    } as never as ManagedPaneInternal
    const webglAddon = { clearTextureAtlas: vi.fn() }
    const livePane = createPane({ webglAddon })
    schedulePaneRevealRepaint(() => [explosivePane, livePane])

    flushFrame()
    flushFrame()

    expect(webglAddon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(livePane.terminal.refresh).toHaveBeenCalled()
  })

  it('falls back to a timeout when animation frames are unavailable', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', undefined)
    const webglAddon = { clearTextureAtlas: vi.fn() }
    const pane = createPane({ webglAddon })

    schedulePaneRevealRepaint(() => [pane])
    vi.runAllTimers()

    expect(webglAddon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  describe('schedulePaneRevealPresent', () => {
    it('presents the settled buffer without wiping the shared glyph atlas', () => {
      // The plain-refocus path must NOT clear the atlas — the clear is a
      // same-config shared wipe that re-arms the mid-stream page-merge race.
      const webglAddon = { clearTextureAtlas: vi.fn() }
      const pane = createPane({ webglAddon })
      schedulePaneRevealPresent(() => [pane])

      flushFrame()
      expect(pane.terminal.refresh).not.toHaveBeenCalled()

      flushFrame()
      expect(webglAddon.clearTextureAtlas).not.toHaveBeenCalled()
      expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)
    })

    it('still retries a missing WebGL attach on the settled frame', () => {
      const pane = createPane()
      schedulePaneRevealPresent(() => [pane])

      flushFrame()
      flushFrame()

      expect(pane.webglAddon).not.toBeNull()
      expect(pane.terminal.refresh).toHaveBeenCalled()
    })
  })
})
