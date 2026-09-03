import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { schedulePaneRevealPresent, schedulePaneRevealRepaint } from './pane-reveal-repaint'
import { registerLivePaneManager, unregisterLivePaneManager } from './pane-manager-registry'
import {
  primeTerminalWebglAddon,
  resetTerminalWebglSuggestion,
  resetWebglTextureAtlas
} from './pane-webgl-renderer'
import { PaneManager } from './pane-manager'

type FakeWebglAddon = { clearTextureAtlas: ReturnType<typeof vi.fn> }
type FakePaneManager = {
  resetWebglTextureAtlases: Mock<() => void>
  refreshAllPanes: Mock<() => void>
}

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

function createVisibilityProbeManager(onValues: () => void): PaneManager {
  const manager = Object.create(PaneManager.prototype) as PaneManager
  Object.assign(manager as unknown as Record<string, unknown>, {
    destroyed: false,
    atlasRecoveryVisible: true,
    panes: {
      values: () => {
        onValues()
        return []
      }
    }
  })
  return manager
}

describe('schedulePaneRevealRepaint', () => {
  let rafQueue: FrameRequestCallback[]
  const registeredManagers: FakePaneManager[] = []

  function registerPaneManager(getPanes: () => Iterable<ManagedPaneInternal>): FakePaneManager {
    const manager: FakePaneManager = {
      resetWebglTextureAtlases: vi.fn(() => {
        for (const pane of getPanes()) {
          resetWebglTextureAtlas(pane)
        }
      }),
      refreshAllPanes: vi.fn(() => {
        for (const pane of getPanes()) {
          pane.terminal.refresh(0, pane.terminal.rows - 1)
        }
      })
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    return manager
  }

  function flushFrame(): void {
    const queue = rafQueue
    rafQueue = []
    for (const callback of queue) {
      callback(16)
    }
  }

  beforeEach(async () => {
    await primeTerminalWebglAddon()
    resetTerminalWebglSuggestion()
    rafQueue = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafQueue.push(callback)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    for (const manager of registeredManagers.splice(0)) {
      unregisterLivePaneManager(manager)
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('repaints only after the post-reveal frame has settled', () => {
    const webglAddon = { clearTextureAtlas: vi.fn() }
    const pane = createPane({ webglAddon })
    registerPaneManager(() => [pane])
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

  it('coordinates a settled atlas clear across recovery-eligible managers', () => {
    const pane = createPane({ webglAddon: { clearTextureAtlas: vi.fn() } })
    const siblingPane = createPane({ webglAddon: { clearTextureAtlas: vi.fn() } })
    const targetManager = registerPaneManager(() => [pane])
    const siblingManager = registerPaneManager(() => [siblingPane])

    schedulePaneRevealRepaint(() => [pane])
    flushFrame()
    flushFrame()

    expect(targetManager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(siblingManager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect((siblingPane.webglAddon as never as FakeWebglAddon).clearTextureAtlas).toHaveBeenCalled()
    expect(siblingPane.terminal.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('coalesces concurrent reveal clears into one global recovery', () => {
    const firstPane = createPane({ webglAddon: { clearTextureAtlas: vi.fn() } })
    const secondPane = createPane({ webglAddon: { clearTextureAtlas: vi.fn() } })
    const firstManager = registerPaneManager(() => [firstPane])
    const secondManager = registerPaneManager(() => [secondPane])

    schedulePaneRevealRepaint(() => [firstPane])
    schedulePaneRevealRepaint(() => [secondPane])
    flushFrame()
    flushFrame()

    expect(firstManager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(secondManager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
  })

  it('reattaches a missing WebGL addon before repainting', () => {
    const pane = createPane()
    const manager = registerPaneManager(() => [pane])
    schedulePaneRevealRepaint(() => [pane])

    flushFrame()
    flushFrame()

    expect(pane.webglAddon).not.toBeNull()
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalled()
  })

  it('resolves the pane list at repaint time, not at scheduling time', () => {
    const stalePane = createPane({ webglAddon: { clearTextureAtlas: vi.fn() } })
    const livePane = createPane({ webglAddon: { clearTextureAtlas: vi.fn() } })
    const panes = [stalePane]
    registerPaneManager(() => panes)
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
    registerPaneManager(() => [explosivePane, livePane])
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
    registerPaneManager(() => [pane])

    schedulePaneRevealRepaint(() => [pane])
    vi.runAllTimers()

    expect(webglAddon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('skips delayed repaint and present when the manager hides before settle', () => {
    let repaintValuesRead = 0
    let presentValuesRead = 0
    const repaintManager = createVisibilityProbeManager(() => {
      repaintValuesRead += 1
    })
    const presentManager = createVisibilityProbeManager(() => {
      presentValuesRead += 1
    })

    repaintManager.scheduleRevealRepaint()
    presentManager.scheduleRevealPresent()
    repaintManager.setAtlasRecoveryVisible(false)
    presentManager.setAtlasRecoveryVisible(false)

    flushFrame()
    flushFrame()

    expect(repaintValuesRead).toBe(0)
    expect(presentValuesRead).toBe(0)
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

    it('reattaches a pane that lost WebGL while hidden when its tab is revealed', () => {
      const pane = createPane()
      pane.webglDisabledAfterContextLoss = true
      pane.webglContextLossTimestamps = [Date.now()]

      schedulePaneRevealPresent(() => [pane])
      flushFrame()
      flushFrame()

      expect(pane.webglDisabledAfterContextLoss).toBe(false)
      expect(pane.webglAddon).not.toBeNull()
      expect(pane.terminal.refresh).toHaveBeenCalledTimes(2)
      expect(pane.terminal.refresh).toHaveBeenNthCalledWith(2, 0, 23)
    })
  })
})
