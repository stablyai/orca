import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { disposePane } from './pane-lifecycle'
import { restoreScrollStateAfterFit } from './pane-scroll'

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

  it('cancels pending fit scroll restoration before terminal disposal', () => {
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 23)
    )
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const pane = createPane(null)
    const marker = { line: 42, isDisposed: false, dispose: vi.fn() }

    restoreScrollStateAfterFit(
      pane.terminal,
      {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
        firstVisibleLineMarker: marker as never
      },
      { onRestored: vi.fn(), shouldRestore: () => true }
    )
    disposePane(pane, new Map([[pane.id, pane]]))

    expect(cancelAnimationFrame).toHaveBeenCalledWith(23)
    expect(marker.dispose).toHaveBeenCalledTimes(1)
  })
})
