import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { disposePane } from './pane-lifecycle'
import { disposeWebgl } from './pane-webgl-renderer'

function createPane(
  overrides: Partial<Pick<ManagedPaneInternal, 'pendingWebglRefreshRafId' | 'webglAddon'>> = {}
): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: {
      element: null,
      rows: 24,
      refresh: vi.fn(),
      dispose: vi.fn()
    } as never,
    container: {} as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'off',
    gpuRenderingEnabled: false,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    fitAddon: {
      fit: vi.fn(),
      dispose: vi.fn()
    } as never,
    fitResizeObserver: null,
    pendingInitialFitRafId: null,
    pendingWebglRefreshRafId: null,
    pendingObservedFitRafId: null,
    searchAddon: { dispose: vi.fn() } as never,
    serializeAddon: { dispose: vi.fn() } as never,
    unicode11Addon: { dispose: vi.fn() } as never,
    webLinksAddon: { dispose: vi.fn() } as never,
    webglAddon: { dispose: vi.fn() } as never,
    ligaturesAddon: null,
    compositionHandler: null,
    pendingSplitScrollState: null,
    pendingSplitScrollBufferDisposable: null,
    debugLabel: null,
    ...overrides
  }
}

describe('pane WebGL refresh lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('tracks the deferred refresh frame after WebGL teardown', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 29)
    )
    const pane = createPane()

    disposeWebgl(pane, { refreshDimensions: true })

    expect(pane.webglAddon).toBeNull()
    expect(pane.pendingWebglRefreshRafId).toBe(29)
  })

  it('cancels a pending WebGL refresh when the pane is disposed', () => {
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const pane = createPane({
      pendingWebglRefreshRafId: 31,
      webglAddon: null
    })
    const panes = new Map([[pane.id, pane]])

    disposePane(pane, panes)

    expect(cancelAnimationFrame).toHaveBeenCalledWith(31)
    expect(pane.pendingWebglRefreshRafId).toBeNull()
    expect(panes.has(pane.id)).toBe(false)
  })
})
