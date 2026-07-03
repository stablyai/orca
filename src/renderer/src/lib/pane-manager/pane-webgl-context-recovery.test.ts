import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { resumePaneRendering } from './pane-rendering-control'
import { attachWebgl, resetTerminalWebglSuggestion } from './pane-webgl-renderer'

function createPane(options: { loadAddon?: () => void } = {}): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111' as never
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

function throwWebglUnavailable(): never {
  // Mirrors the addon's activate() throw when getContext('webgl2') returns null.
  throw new Error('WebGL2 not supported null')
}

function fireContextLoss(pane: ManagedPaneInternal): void {
  // Fire the addon's real context-loss emitter so the loss -> latch -> resume
  // cycle runs through the production onContextLoss handler.
  const addon = pane.webglAddon as unknown as { _onContextLoss: { fire: () => void } }
  addon._onContextLoss.fire()
}

describe('terminal WebGL context recovery', () => {
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

  it('backs off after a failed attach instead of retrying on every call', () => {
    const pane = createPane({ loadAddon: throwWebglUnavailable })

    attachWebgl(pane)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
    expect(pane.webglAddon).toBeNull()

    // Title changes re-enter attach via setPaneGpuRendering; while WebGL is
    // blocked these must not construct new addons or log again.
    attachWebgl(pane)
    attachWebgl(pane)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('retries a backed-off attach on the next rendering resume', () => {
    const pane = createPane({ loadAddon: throwWebglUnavailable })

    attachWebgl(pane)
    attachWebgl(pane)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)

    resumePaneRendering([pane])
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(2)
  })

  it('recovers a context-lost pane on the next rendering resume', () => {
    const pane = createPane()

    attachWebgl(pane)
    expect(pane.webglAddon).not.toBeNull()

    fireContextLoss(pane)
    expect(pane.webglDisabledAfterContextLoss).toBe(true)
    expect(pane.webglAddon).toBeNull()

    resumePaneRendering([pane])
    expect(pane.webglDisabledAfterContextLoss).toBe(false)
    expect(pane.webglAddon).not.toBeNull()
  })

  it('re-latches when the retried context is lost again', () => {
    const pane = createPane()

    attachWebgl(pane)
    fireContextLoss(pane)
    resumePaneRendering([pane])
    expect(pane.webglAddon).not.toBeNull()

    fireContextLoss(pane)
    expect(pane.webglDisabledAfterContextLoss).toBe(true)
    expect(pane.webglAddon).toBeNull()
  })
})
