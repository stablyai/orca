import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManagedPaneInternal } from './pane-manager-types'

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
