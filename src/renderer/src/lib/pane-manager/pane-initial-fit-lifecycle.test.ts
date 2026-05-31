import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { disposePane } from './pane-lifecycle'

function createPane(pendingInitialFitRafId: number | null): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: {
      element: null,
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
    fitAddon: { dispose: vi.fn() } as never,
    fitResizeObserver: null,
    pendingInitialFitRafId,
    pendingObservedFitRafId: null,
    searchAddon: { dispose: vi.fn() } as never,
    serializeAddon: { dispose: vi.fn() } as never,
    unicode11Addon: { dispose: vi.fn() } as never,
    webLinksAddon: { dispose: vi.fn() } as never,
    webglAddon: null,
    ligaturesAddon: null,
    compositionHandler: null,
    pendingSplitScrollState: null,
    pendingSplitScrollBufferDisposable: null,
    debugLabel: null
  }
}

describe('pane initial fit lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cancels pending initial fit when the pane is disposed before paint', () => {
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const pane = createPane(17)
    const panes = new Map([[pane.id, pane]])

    disposePane(pane, panes)

    expect(cancelAnimationFrame).toHaveBeenCalledWith(17)
    expect(pane.pendingInitialFitRafId).toBeNull()
    expect(panes.has(pane.id)).toBe(false)
  })
})
