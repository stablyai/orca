import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  attachWebgl,
  clearWebglTextureAtlas,
  primeTerminalWebglAddon,
  resetTerminalWebglSuggestion
} from './pane-webgl-renderer'
import { safeFit } from './pane-fit'
import { disposePane } from './pane-lifecycle'

/** Create a minimal managed pane stub for WebGL lifecycle tests. */
function createPane(
  options: { loadAddon?: (addon: WebglAddon) => void } = {}
): ManagedPaneInternal {
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

  it('caps atlas texture size at 2048 and shrinks unused GPU texture slots on invalidate and clear', () => {
    class FakeTextureAtlas {
      static maxTextureSize = 16384
      _config = { deviceMaxTextureSize: 16384 }
      pages = [{ canvas: { width: 512, height: 512 }, version: 3 }]
    }
    const atlas = new FakeTextureAtlas()
    const resizedSlots: { unit: number; width: number; height: number }[] = []
    const textures = [
      { texture: {}, version: 3 },
      { texture: {}, version: 7 },
      { texture: {}, version: 9 }
    ]
    let activeUnit = 0
    const glyphRenderer = {
      _atlas: atlas,
      _atlasTextures: textures,
      invalidateAtlasTextures(): void {
        for (const entry of textures) {
          entry.version = -1
        }
      }
    }
    let onRemovedCanvas: ((canvas: { width: number; height: number }) => void) | undefined
    const pane = createPane({
      loadAddon: (addon) => {
        Object.assign(addon, {
          onRemoveTextureAtlasCanvas: (
            listener: (canvas: { width: number; height: number }) => void
          ) => {
            onRemovedCanvas = listener
          },
          _renderer: {
            clearTextureAtlas: () => {},
            _deviceMaxTextureSize: 16384,
            _charAtlas: atlas,
            _glyphRenderer: { value: glyphRenderer },
            _gl: {
              TEXTURE0: 0x84c0,
              TEXTURE_2D: 0x0de1,
              RGBA: 0x1908,
              UNSIGNED_BYTE: 0x1401,
              activeTexture: (unit: number) => {
                activeUnit = unit - 0x84c0
              },
              bindTexture: () => {},
              texImage2D: (
                _target: number,
                _level: number,
                _internalformat: number,
                width: number,
                height: number
              ) => {
                resizedSlots.push({ unit: activeUnit, width, height })
              }
            }
          }
        })
      }
    })

    attachWebgl(pane)

    expect(FakeTextureAtlas.maxTextureSize).toBe(2048)
    expect(atlas._config.deviceMaxTextureSize).toBe(2048)

    const mergedCanvas = { width: 4096, height: 4096 }
    onRemovedCanvas?.(mergedCanvas)
    expect(mergedCanvas.width).toBe(0)
    expect(mergedCanvas.height).toBe(0)

    glyphRenderer.invalidateAtlasTextures()
    expect(resizedSlots).toEqual([
      { unit: 1, width: 1, height: 1 },
      { unit: 2, width: 1, height: 1 }
    ])

    resizedSlots.length = 0
    textures[0].version = 5
    clearWebglTextureAtlas(pane)
    expect(textures[0].version).toBe(-1)
    expect(resizedSlots).toEqual([
      { unit: 0, width: 1, height: 1 },
      { unit: 1, width: 1, height: 1 },
      { unit: 2, width: 1, height: 1 }
    ])
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
