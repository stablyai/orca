import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  clearRetainedWebglPanes,
  RETAINED_WEBGL_PANE_CAP,
  retainedWebglPaneCount
} from './pane-webgl-context-retention'
import { resumePaneRendering, suspendPaneRendering } from './pane-rendering-control'
import {
  attachWebgl,
  disposeWebgl,
  resetTerminalWebglSuggestion,
  resetWebglTextureAtlas
} from './pane-webgl-renderer'

let nextPaneId = 1

function createPane(): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111' as never
  return {
    id: nextPaneId++,
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

function createAttachedPane(): ManagedPaneInternal {
  const pane = createPane()
  attachWebgl(pane)
  expect(pane.webglAddon).not.toBeNull()
  return pane
}

function fireContextLoss(pane: ManagedPaneInternal): void {
  const addon = pane.webglAddon as unknown as { _onContextLoss: { fire: () => void } }
  addon._onContextLoss.fire()
}

function stubCommonGlobals(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(16)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
}

describe('terminal WebGL context retention across hide/show (Windows)', () => {
  beforeEach(() => {
    resetTerminalWebglSuggestion()
    clearRetainedWebglPanes()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubCommonGlobals('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  })

  afterEach(() => {
    clearRetainedWebglPanes()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the live WebGL addon when rendering is suspended', () => {
    const pane = createAttachedPane()
    const addon = pane.webglAddon

    suspendPaneRendering([pane])

    expect(pane.webglAttachmentDeferred).toBe(true)
    expect(pane.webglAddon).toBe(addon)
    expect(retainedWebglPaneCount()).toBe(1)
  })

  it('does not create a new context when resuming a retained pane', () => {
    const pane = createAttachedPane()
    const addon = pane.webglAddon
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)

    suspendPaneRendering([pane])
    resumePaneRendering([pane])

    expect(pane.webglAddon).toBe(addon)
    expect(pane.webglAttachmentDeferred).toBe(false)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
    expect(retainedWebglPaneCount()).toBe(0)
  })

  it('still blocks new context creation while suspended', () => {
    const pane = createPane()

    suspendPaneRendering([pane])
    attachWebgl(pane)

    expect(pane.webglAddon).toBeNull()
    expect(pane.terminal.loadAddon).not.toHaveBeenCalled()
  })

  it('evicts and disposes the least-recently-suspended pane past the cap', () => {
    const panes = Array.from({ length: RETAINED_WEBGL_PANE_CAP + 2 }, () => createAttachedPane())

    suspendPaneRendering(panes)

    expect(retainedWebglPaneCount()).toBe(RETAINED_WEBGL_PANE_CAP)
    expect(panes[0].webglAddon).toBeNull()
    expect(panes[1].webglAddon).toBeNull()
    expect(panes[2].webglAddon).not.toBeNull()
    expect(panes.at(-1)?.webglAddon).not.toBeNull()
  })

  it('re-attaches an evicted pane on resume', () => {
    const panes = Array.from({ length: RETAINED_WEBGL_PANE_CAP + 1 }, () => createAttachedPane())
    suspendPaneRendering(panes)
    expect(panes[0].webglAddon).toBeNull()

    resumePaneRendering([panes[0]])

    expect(panes[0].webglAddon).not.toBeNull()
    expect(panes[0].terminal.loadAddon).toHaveBeenCalledTimes(2)
  })

  it('drops the retention entry when a suspended pane is disposed', () => {
    const pane = createAttachedPane()
    suspendPaneRendering([pane])
    expect(retainedWebglPaneCount()).toBe(1)

    disposeWebgl(pane)

    expect(retainedWebglPaneCount()).toBe(0)
    expect(pane.webglAddon).toBeNull()
  })

  it('repaints a retained pane on resume so a cleared shared atlas cannot leave stale glyphs', () => {
    const pane = createAttachedPane()
    suspendPaneRendering([pane])
    vi.mocked(pane.terminal.refresh).mockClear()

    resumePaneRendering([pane])

    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, pane.terminal.rows - 1)
  })

  it('skips suspended panes during atlas recovery resets', () => {
    const pane = createAttachedPane()
    const clearTextureAtlas = vi.fn()
    ;(pane.webglAddon as unknown as { clearTextureAtlas: () => void }).clearTextureAtlas =
      clearTextureAtlas
    suspendPaneRendering([pane])
    vi.mocked(pane.terminal.refresh).mockClear()

    resetWebglTextureAtlas(pane)

    expect(clearTextureAtlas).not.toHaveBeenCalled()
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })

  it('drops the retention entry on context loss while hidden and recovers on resume', () => {
    const pane = createAttachedPane()
    suspendPaneRendering([pane])

    fireContextLoss(pane)

    expect(pane.webglAddon).toBeNull()
    expect(pane.webglDisabledAfterContextLoss).toBe(true)
    expect(retainedWebglPaneCount()).toBe(0)

    resumePaneRendering([pane])

    expect(pane.webglDisabledAfterContextLoss).toBe(false)
    expect(pane.webglAddon).not.toBeNull()
  })
})

describe('terminal WebGL context retention is Windows-only', () => {
  beforeEach(() => {
    resetTerminalWebglSuggestion()
    clearRetainedWebglPanes()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubCommonGlobals('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
  })

  afterEach(() => {
    clearRetainedWebglPanes()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the dispose-on-hide behavior off Windows', () => {
    const pane = createAttachedPane()

    suspendPaneRendering([pane])

    expect(pane.webglAttachmentDeferred).toBe(true)
    expect(pane.webglAddon).toBeNull()
    expect(retainedWebglPaneCount()).toBe(0)
  })

  it('re-attaches on resume off Windows as before', () => {
    const pane = createAttachedPane()
    suspendPaneRendering([pane])

    resumePaneRendering([pane])

    expect(pane.webglAddon).not.toBeNull()
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(2)
  })
})
