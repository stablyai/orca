import { describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { disposePane } from './pane-lifecycle'

function makePane(): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: { dispose: vi.fn() } as never,
    container: { removeEventListener: vi.fn() } as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: false,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    fitAddon: { dispose: vi.fn() } as never,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    searchAddon: { dispose: vi.fn() } as never,
    serializeAddon: { dispose: vi.fn() } as never,
    unicode11Addon: { dispose: vi.fn() } as never,
    webLinksAddon: { dispose: vi.fn() } as never,
    webglAddon: null,
    ligaturesAddon: null,
    panePointerDownHandler: vi.fn(),
    paneMouseEnterHandler: vi.fn(),
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

describe('disposePane container listener cleanup', () => {
  it('removes pane container focus listeners', () => {
    const pane = makePane()
    const pointerDownHandler = pane.panePointerDownHandler
    const mouseEnterHandler = pane.paneMouseEnterHandler
    const panes = new Map([[pane.id, pane]])

    disposePane(pane, panes)

    expect(pane.container.removeEventListener).toHaveBeenCalledWith(
      'pointerdown',
      pointerDownHandler
    )
    expect(pane.container.removeEventListener).toHaveBeenCalledWith('mouseenter', mouseEnterHandler)
    expect(pane.panePointerDownHandler).toBeNull()
    expect(pane.paneMouseEnterHandler).toBeNull()
    expect(panes.has(pane.id)).toBe(false)
  })

  it('runs pane drag cleanup', () => {
    const pane = makePane()
    const paneDragCleanup = vi.fn()
    pane.paneDragCleanup = paneDragCleanup
    const panes = new Map([[pane.id, pane]])

    disposePane(pane, panes)

    expect(paneDragCleanup).toHaveBeenCalledTimes(1)
    expect(pane.paneDragCleanup).toBeNull()
  })
})
