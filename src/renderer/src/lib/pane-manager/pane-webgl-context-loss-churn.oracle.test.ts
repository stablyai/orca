import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { resumePaneRendering } from './pane-rendering-control'
import { attachWebgl, resetTerminalWebglSuggestion } from './pane-webgl-renderer'

function createPane(): ManagedPaneInternal {
  const leafId = '44444444-4444-4444-8444-444444444444' as never
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

function fireContextLoss(pane: ManagedPaneInternal): void {
  const addon = pane.webglAddon as unknown as { _onContextLoss: { fire: () => void } }
  addon._onContextLoss.fire()
}

function loseAndResume(pane: ManagedPaneInternal): void {
  fireContextLoss(pane)
  expect(pane.webglAddon).toBeNull()
  expect(pane.webglDisabledAfterContextLoss).toBe(true)
  resumePaneRendering([pane])
}

describe('WebGL context-loss churn oracle', () => {
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

  it('keeps the third context-loss fallback on the DOM renderer across resume', () => {
    const pane = createPane()
    attachWebgl(pane)

    loseAndResume(pane)
    expect(pane.webglAddon).not.toBeNull()
    loseAndResume(pane)
    expect(pane.webglAddon).not.toBeNull()
    loseAndResume(pane)

    expect(pane.webglAddon).toBeNull()
    expect(pane.webglDisabledAfterContextLoss).toBe(true)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(3)
  })
})
