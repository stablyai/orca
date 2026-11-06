import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  attachWebgl,
  primeTerminalWebglAddon,
  resetTerminalWebglSuggestion
} from './pane-webgl-renderer'
import { safeFit } from './pane-fit'
import { disposePane } from './pane-lifecycle'
import { presentPaneViewport } from './pane-viewport-present'

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
    imageAddon: null,
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
  // WebGL floors device-cell widths, widening the proposed grid; reattach must settle that divergence.
  pane.fitAddon.proposeDimensions = vi.fn(() =>
    pane.webglAddon ? { cols: 84, rows: 24 } : { cols: 80, rows: 24 }
  ) as never
  return pane
}

describe('terminal WebGL addon lifecycle', () => {
  beforeEach(async () => {
    await primeTerminalWebglAddon()
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

    // A leaked addon kept painting stale frames while recovery and diagnostics believed it was DOM-rendered.
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

  it('paints a newly attached canvas inside a synchronized frame instead of leaving it blank', () => {
    const renderRows = vi.fn()
    const pane = createPane()
    Object.assign(pane.terminal, {
      _core: {
        _renderService: {
          _isPaused: false,
          _needsFullRefresh: false,
          refreshRows: vi.fn(),
          _renderer: { value: { renderRows } }
        },
        coreService: { decPrivateModes: { synchronizedOutput: true } }
      }
    })

    attachWebgl(pane)

    expect(pane.webglAddon).not.toBeNull()
    expect(renderRows).toHaveBeenCalledWith(0, 23)
  })

  it('keeps an attached, already painted renderer tear-free inside a synchronized frame', () => {
    const renderRows = vi.fn()
    const refreshRows = vi.fn()
    const pane = createPane()
    Object.assign(pane.container, { getBoundingClientRect: () => ({ width: 800, height: 400 }) })
    const decPrivateModes = { synchronizedOutput: false }
    Object.assign(pane.terminal, {
      _core: {
        _renderService: {
          _isPaused: false,
          _needsFullRefresh: false,
          refreshRows,
          _renderer: { value: { renderRows } }
        },
        coreService: { decPrivateModes }
      }
    })
    attachWebgl(pane)
    decPrivateModes.synchronizedOutput = true

    presentPaneViewport(pane)

    expect(renderRows).not.toHaveBeenCalled()
    expect(refreshRows).toHaveBeenCalledWith(0, 23, true)
  })

  it('paints a canvas attached while paused on its reveal present, inside a synchronized frame', () => {
    const renderRows = vi.fn()
    const renderService = {
      _isPaused: true,
      _needsFullRefresh: false,
      refreshRows: vi.fn(),
      _renderer: { value: { renderRows } }
    }
    const pane = createPane()
    Object.assign(pane.container, { getBoundingClientRect: () => ({ width: 800, height: 400 }) })
    Object.assign(pane.terminal, {
      onRender: vi.fn(() => ({ dispose: vi.fn() })),
      _core: {
        _renderService: renderService,
        coreService: { decPrivateModes: { synchronizedOutput: true } }
      }
    })

    attachWebgl(pane)
    expect(renderRows).not.toHaveBeenCalled()
    expect(renderService._isPaused).toBe(true)

    presentPaneViewport(pane)
    expect(renderRows).toHaveBeenCalledWith(0, 23)

    // Only that one paint may land mid-frame; later presents wait for the frame to close.
    renderRows.mockClear()
    presentPaneViewport(pane)
    expect(renderRows).not.toHaveBeenCalled()
    expect(renderService.refreshRows).toHaveBeenCalledWith(0, 23, true)
  })

  it('keeps attaching to healthy panes after another pane fails to attach', () => {
    // A module-global attach latch once stranded all later panes on wider/bolder DOM rendering after one pane failed.
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
})

// Deferred rAF exposes live refit handles so teardown/reentry are tested; synchronous stubs cannot.
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
    // An uncancelled refit would resize the PTY after terminal disposal.
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
    for (let index = 0; index < frames.length && index < 8; index += 1) {
      const frame = frames[index]
      frames[index] = null
      frame?.(16)
    }

    expect(frames.length).toBe(1)
    expect(pane.pendingWebglRefreshRafId).toBeNull()
  })
})

// Lazy loading adds unresolved chunks and panes opened before resolution; static imports had neither failure mode.
describe('deferred WebGL addon load', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(16)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.doUnmock('@xterm/addon-webgl')
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('refits a pane that attached while the addon was still loading', async () => {
    // Refit after attaching: WebGL floors cell widths differently, so keeping the initial DOM grid permanently narrows the PTY.
    const renderer = await import('./pane-webgl-renderer')
    const pane = createFittablePane()

    renderer.attachWebgl(pane)
    expect(pane.webglAddon).toBeNull()

    await renderer.primeTerminalWebglAddon()

    expect(pane.webglAddon).not.toBeNull()
    expect(pane.fitAddon.fit).toHaveBeenCalled()
  })

  it('retries a failed load instead of latching the DOM renderer for the session', async () => {
    let loadShouldFail = true
    vi.doMock('@xterm/addon-webgl', () => {
      if (loadShouldFail) {
        throw new Error('chunk load failed')
      }
      return {
        WebglAddon: class {
          onContextLoss(): void {}
          clearTextureAtlas(): void {}
          dispose(): void {}
        }
      }
    })
    const renderer = await import('./pane-webgl-renderer')
    const pane = createPane()

    await renderer.primeTerminalWebglAddon()
    renderer.attachWebgl(pane)
    await Promise.resolve()
    expect(pane.webglAddon).toBeNull()

    // GPU settings recovery must rearm the load as well as auto selection; cached settled promises cannot retry.
    loadShouldFail = false
    renderer.resetTerminalWebglSuggestion()
    renderer.clearTerminalWebglAttachBackoff(pane)
    await renderer.primeTerminalWebglAddon()
    renderer.attachWebgl(pane)

    expect(pane.webglAddon).not.toBeNull()
  })
})
