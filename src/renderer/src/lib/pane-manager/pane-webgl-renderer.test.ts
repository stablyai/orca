import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  attachWebgl,
  clearTerminalWebglAttachBackoff,
  presentPaneViewport,
  presentPaneViewportPreservingSynchronizedOutput,
  resetTerminalWebglSuggestion,
  resetWebglTextureAtlas
} from './pane-webgl-renderer'
import { notifyPaneFitSucceeded } from './pane-fit-webgl-attach-signal'
import { safeFit } from './pane-fit'
import { disposePane } from './pane-lifecycle'

function createPane(options: { loadAddon?: () => void } = {}): ManagedPaneInternal {
  const leafId = '22222222-2222-4222-8222-222222222222' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: {
      cols: 80,
      rows: 24,
      refresh: vi.fn(),
      loadAddon: vi.fn(options.loadAddon)
    } as never,
    container: {} as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'on',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: null,
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

function createFittablePane(): ManagedPaneInternal {
  const pane = createPane()
  const rect = { width: 800, height: 400 }
  pane.container = { dataset: {}, getBoundingClientRect: () => rect } as never
  pane.xtermContainer = { getBoundingClientRect: () => rect } as never
  // Why: WebGL floors the device cell width, so the same box proposes a wider
  // grid once the addon is live — the divergence the reattach has to settle.
  pane.fitAddon.proposeDimensions = vi.fn(() =>
    pane.webglAddon ? { cols: 84, rows: 24 } : { cols: 80, rows: 24 }
  ) as never
  return pane
}

type FakeRenderService = {
  _isPaused: boolean
  _needsFullRefresh: boolean
  refreshRows: Mock<(start: number, end: number, sync?: boolean) => void>
}

/** A pane whose xterm render service is paused, as it is whenever the pane has
 *  no layout box: `display` decides whether the element is one xterm's
 *  IntersectionObserver would report as intersecting. */
function createPausedPane(display: 'block' | 'none'): {
  pane: ManagedPaneInternal
  renderService: FakeRenderService
  setDisplay: (next: 'block' | 'none') => void
} {
  const pane = createPane()
  const renderService: FakeRenderService = {
    _isPaused: true,
    _needsFullRefresh: false,
    // Mirrors xterm: a refresh while paused only latches the pending full repaint.
    refreshRows: vi.fn<(start: number, end: number, sync?: boolean) => void>(() => {
      if (renderService._isPaused) {
        renderService._needsFullRefresh = true
      }
    })
  }
  let currentDisplay = display
  const view = { getComputedStyle: () => ({ display: currentDisplay }) }
  const element = { ownerDocument: { defaultView: view }, parentElement: null }
  pane.container = element as never
  pane.xtermContainer = element as never
  pane.terminal = {
    ...pane.terminal,
    refresh: vi.fn(() => renderService.refreshRows(0, pane.terminal.rows - 1)),
    _core: { _renderService: renderService }
  } as never
  return {
    pane,
    renderService,
    setDisplay: (next) => {
      currentDisplay = next
    }
  }
}

describe('terminal WebGL addon lifecycle', () => {
  beforeEach(() => {
    resetTerminalWebglSuggestion()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(16)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('disposes a live addon when attach bails instead of orphaning it', () => {
    const pane = createPane()
    attachWebgl(pane)
    const liveAddon = pane.webglAddon
    expect(liveAddon).not.toBeNull()
    const disposeSpy = vi.spyOn(liveAddon as WebglAddon, 'dispose')

    // An undisposed addon here kept painting stale frames while atlas resets,
    // reattach checks, and diagnostics all treated the pane as DOM-rendered.
    pane.webglAttachmentDeferred = true
    attachWebgl(pane)

    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(pane.webglAddon).toBeNull()
  })

  it('disposes the previous addon before attaching a replacement', () => {
    const pane = createPane()
    attachWebgl(pane)
    const firstAddon = pane.webglAddon
    expect(firstAddon).not.toBeNull()
    const disposeSpy = vi.spyOn(firstAddon as WebglAddon, 'dispose')

    attachWebgl(pane)

    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(pane.webglAddon).not.toBeNull()
    expect(pane.webglAddon).not.toBe(firstAddon)
  })

  it('disposes the constructed addon when loading it fails', () => {
    const disposeSpy = vi.spyOn(WebglAddon.prototype, 'dispose')
    const pane = createPane({
      loadAddon: () => {
        throw new Error('WebGL2 not supported null')
      }
    })

    attachWebgl(pane)

    expect(pane.webglAddon).toBeNull()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('still refreshes the terminal when resetting a pane without a WebGL addon', () => {
    const pane = createPane()
    expect(pane.webglAddon).toBeNull()

    resetWebglTextureAtlas(pane)

    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('falls back to terminal.refresh on an unpaused, unsynchronized pane', () => {
    // Restore-after-replay and other callers use presentPaneViewport even when
    // forceFullViewportPresent is a no-op (not paused, no DEC 2026).
    const refreshRows = vi.fn()
    const renderRows = vi.fn()
    const pane = createPane()
    pane.terminal = {
      ...pane.terminal,
      refresh: vi.fn(),
      _core: {
        _renderService: {
          _isPaused: false,
          _needsFullRefresh: false,
          refreshRows,
          _renderer: { value: { renderRows } }
        },
        coreService: { decPrivateModes: { synchronizedOutput: false } }
      }
    } as never

    presentPaneViewport(pane)

    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)
    expect(refreshRows).not.toHaveBeenCalled()
    expect(renderRows).not.toHaveBeenCalled()
  })

  it('preserves a synchronized frame on an ordinary reveal present', () => {
    const refreshRows = vi.fn()
    const renderRows = vi.fn()
    const pane = createPane()
    pane.terminal = {
      ...pane.terminal,
      refresh: vi.fn(),
      _core: {
        _renderService: {
          _isPaused: false,
          _needsFullRefresh: false,
          refreshRows,
          _renderer: { value: { renderRows } }
        },
        coreService: { decPrivateModes: { synchronizedOutput: true } }
      }
    } as never

    presentPaneViewportPreservingSynchronizedOutput(pane)

    expect(refreshRows).toHaveBeenCalledWith(0, 23, true)
    expect(renderRows).not.toHaveBeenCalled()
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })

  it('keeps the render pause latched when resetting a pane that has no layout box', () => {
    // Regression: the atlas reset released xterm's pause for every pane of a
    // visible manager, including a collapsed sibling of an expanded pane. That
    // painted the freshly cleared model into an element with no box, and left
    // the service unpaused for good — the IntersectionObserver only fires on a
    // change, so it never re-pauses. Clearing _needsFullRefresh with it drops
    // the repaint the observer owes the pane on reveal, and the deferred
    // _pausedResizeTask that rides along with it.
    const { pane, renderService } = createPausedPane('none')

    resetWebglTextureAtlas(pane)

    expect(renderService._isPaused).toBe(true)
    expect(renderService._needsFullRefresh).toBe(true)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('retries a display:none present after the overlay actually shows a box', () => {
    // Field traces show paused=true needFull=true because the
    // first present ran while the overlay was still display:none. Selection
    // later healed the inner rows; only a resize cleared the sides. Flush the
    // retry after the box exists so the full present actually runs.
    const queued: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queued.push(callback)
      return queued.length
    })
    const { pane, renderService, setDisplay } = createPausedPane('none')

    presentPaneViewport(pane)

    expect(renderService._isPaused).toBe(true)
    expect(queued).toHaveLength(1)

    setDisplay('block')
    queued.shift()?.(16)

    expect(renderService._isPaused).toBe(false)
    expect(renderService.refreshRows).toHaveBeenCalledWith(0, 23, true)
  })

  it('caps display:none present retries', () => {
    const queued: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queued.push(callback)
      return queued.length
    })
    const { pane, renderService } = createPausedPane('none')

    presentPaneViewport(pane)
    presentPaneViewport(pane)
    expect(queued).toHaveLength(1)
    let callbacks = 0
    while (queued.length > 0) {
      queued.shift()?.(callbacks * 16)
      callbacks += 1
    }

    expect(callbacks).toBe(16)
    expect(renderService._isPaused).toBe(true)
    expect(renderService.refreshRows).toHaveBeenCalledTimes(2)
  })

  it('still forces the paused render through for a pane that has a layout box', () => {
    // The reveal case the release exists for: DOM-visible, but xterm's observer
    // has not caught up, so a plain refresh() would be swallowed.
    const { pane, renderService } = createPausedPane('block')

    resetWebglTextureAtlas(pane)

    expect(renderService._isPaused).toBe(false)
    expect(renderService._needsFullRefresh).toBe(false)
    expect(renderService.refreshRows).toHaveBeenCalledWith(0, 23, true)
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })

  it('skips the reset while WebGL is latched off after a context loss', () => {
    const pane = createPane()
    pane.webglDisabledAfterContextLoss = true

    resetWebglTextureAtlas(pane)

    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })

  it('keeps attaching to healthy panes after another pane fails to attach', () => {
    // Regression: the attach-failure latch was module-global, so one pane's
    // failed context creation stranded every later pane on the DOM renderer
    // (bold/wider text) until the next recovery boundary.
    const failing = createPane({
      loadAddon: () => {
        throw new Error('WebGL2 not supported null')
      }
    })
    attachWebgl(failing)
    expect(failing.webglAddon).toBeNull()
    expect(failing.webglAttachFailedSinceRecovery).toBe(true)

    const healthy = createPane()
    attachWebgl(healthy)

    expect(healthy.webglAddon).not.toBeNull()
    expect(healthy.webglAttachFailedSinceRecovery).not.toBe(true)
  })

  it('honors the per-pane failure latch until it is cleared', () => {
    const loadAddon = vi.fn(() => {
      throw new Error('WebGL2 not supported null')
    })
    const pane = createPane({ loadAddon })

    attachWebgl(pane)
    attachWebgl(pane)

    // Second attempt must not burn another canvas/getContext while latched.
    expect(loadAddon).toHaveBeenCalledTimes(1)

    clearTerminalWebglAttachBackoff(pane)
    attachWebgl(pane)

    expect(loadAddon).toHaveBeenCalledTimes(2)
  })
})

describe('fit-anchored WebGL reattach', () => {
  beforeEach(() => {
    resetTerminalWebglSuggestion()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(16)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('attaches WebGL to an eligible addon-less pane when a fit succeeds', () => {
    // The event-anchored heal: a user resize (or late mount) proves the pane
    // measurable, which is the moment a DOM-stuck pane can regain WebGL.
    const pane = createPane()
    expect(pane.webglAddon).toBeNull()

    notifyPaneFitSucceeded(pane)

    expect(pane.webglAddon).not.toBeNull()
  })

  it('does not retry a pane whose attach already failed since recovery', () => {
    const loadAddon = vi.fn(() => {
      throw new Error('WebGL2 not supported null')
    })
    const pane = createPane({ loadAddon })
    attachWebgl(pane)
    expect(loadAddon).toHaveBeenCalledTimes(1)

    notifyPaneFitSucceeded(pane)

    // Failed attaches retry only at recovery boundaries, never on every fit.
    expect(loadAddon).toHaveBeenCalledTimes(1)
    expect(pane.webglAddon).toBeNull()
  })

  it('leaves suspended and context-loss panes alone on fit', () => {
    const deferred = createPane()
    deferred.webglAttachmentDeferred = true
    notifyPaneFitSucceeded(deferred)
    expect(deferred.webglAddon).toBeNull()

    const lost = createPane()
    lost.webglDisabledAfterContextLoss = true
    notifyPaneFitSucceeded(lost)
    expect(lost.webglAddon).toBeNull()
  })

  it('does not disturb a pane that already has a live addon', () => {
    const pane = createPane()
    attachWebgl(pane)
    const liveAddon = pane.webglAddon
    expect(liveAddon).not.toBeNull()

    notifyPaneFitSucceeded(pane)

    expect(pane.webglAddon).toBe(liveAddon)
  })
})

// Why a separate suite: the tests above drive the signal directly, so they stay
// green even if safeFit stops calling it. These go through the real fit path so
// the wiring — and the import-time hook registration — is what is under test.
describe('safeFit drives the fit-anchored WebGL reattach', () => {
  beforeEach(() => {
    resetTerminalWebglSuggestion()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(16)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('attaches WebGL when a real safeFit completes', () => {
    const pane = createFittablePane()

    expect(safeFit(pane)).toBe(true)

    expect(pane.webglAddon).not.toBeNull()
  })

  it('refits the pane onto the WebGL cell metrics after attaching', () => {
    // Without the follow-up fit the healed pane keeps the DOM-derived column
    // count, leaving an unpainted gutter and a PTY narrower than the pane.
    const pane = createFittablePane()
    const hadAddonPerFit: boolean[] = []
    pane.fitAddon.fit = vi.fn(() => {
      hadAddonPerFit.push(pane.webglAddon != null)
    }) as never

    safeFit(pane)

    expect(hadAddonPerFit).toEqual([true])
  })

  it('does not fit when the pane is unmeasurable', () => {
    const pane = createFittablePane()
    pane.container = {
      dataset: {},
      getBoundingClientRect: () => ({ width: 0, height: 0 })
    } as never

    expect(safeFit(pane)).toBe(false)

    expect(pane.webglAddon).toBeNull()
  })
})

// Why a deferred stub: the suites above run rAF synchronously, so the window in
// which the refit handle is live never exists there — and that window is exactly
// where teardown and re-entry have to hold.
describe('the deferred fit-anchored refit frame', () => {
  const frames: (FrameRequestCallback | null)[] = []
  const cancelledFrameIds: number[] = []

  beforeEach(() => {
    frames.length = 0
    cancelledFrameIds.length = 0
    resetTerminalWebglSuggestion()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      cancelledFrameIds.push(id)
      frames[id - 1] = null
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('cancels the refit when the pane is disposed before the frame runs', () => {
    // An uncancelled handle refits — and forwards a PTY resize for — a pane
    // whose terminal is already disposed.
    const pane = createFittablePane()
    safeFit(pane)
    const refitFrameId = pane.pendingWebglRefreshRafId
    expect(refitFrameId).not.toBeNull()

    disposePane(pane, new Map([[pane.id, pane]]))

    expect(cancelledFrameIds).toContain(refitFrameId)
    expect(pane.pendingWebglRefreshRafId).toBeNull()
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
  })

  it('settles after one refit instead of cycling fit -> attach -> fit', () => {
    const pane = createFittablePane()

    safeFit(pane)
    // Bounded drain: a cycle would keep queueing frames past the cap.
    for (let index = 0; index < frames.length && index < 8; index += 1) {
      const frame = frames[index]
      frames[index] = null
      frame?.(16)
    }

    expect(frames.length).toBe(1)
    expect(pane.pendingWebglRefreshRafId).toBeNull()
  })
})
