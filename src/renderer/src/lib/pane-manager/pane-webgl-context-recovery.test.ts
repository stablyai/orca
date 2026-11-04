import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { resumePaneRendering, suspendPaneRendering } from './pane-rendering-control'
import { schedulePaneRevealPresent } from './pane-reveal-repaint'
import {
  attachWebgl,
  primeTerminalWebglAddon,
  resetTerminalWebglSuggestion
} from './pane-webgl-renderer'
import { rebuildAttachedWebgl } from './pane-webgl-reattach'

function createPane(): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery uses only the mocked terminal methods below.
    terminal: {
      options: { cursorBlink: true },
      cols: 80,
      rows: 24,
      refresh: vi.fn(),
      blur: vi.fn(),
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

function fireContextLoss(pane: ManagedPaneInternal): void {
  // Use the real context-loss emitter to cover production latch/resume wiring.
  const addon = pane.webglAddon as unknown as { _onContextLoss: { fire: () => void } }
  addon._onContextLoss.fire()
}

describe('terminal WebGL context recovery', () => {
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

  it('defers retained replay rebuilds until rendering resumes', () => {
    const owner = {}
    const pane = createPane()
    attachWebgl(pane)
    const retainedAddon = pane.webglAddon
    suspendPaneRendering([pane], { owner, livePanes: () => [pane] })

    rebuildAttachedWebgl(pane)

    expect(pane.webglAddon).toBe(retainedAddon)
    expect(pane.webglRebuildDeferred).toBe(true)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)

    resumePaneRendering([pane], owner)

    expect(pane.webglAddon).not.toBe(retainedAddon)
    expect(pane.webglRebuildDeferred).toBe(false)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(2)
  })

  it('stops resume retries after repeated losses in the retry window', () => {
    const pane = createPane()

    attachWebgl(pane)
    fireContextLoss(pane)
    resumePaneRendering([pane])
    fireContextLoss(pane)
    resumePaneRendering([pane])
    fireContextLoss(pane)

    expect(pane.webglContextLossTimestamps).toHaveLength(3)
    expect(pane.webglDisabledAfterContextLoss).toBe(true)
    expect(pane.webglAddon).toBeNull()

    resumePaneRendering([pane])

    expect(pane.webglDisabledAfterContextLoss).toBe(true)
    expect(pane.webglAddon).toBeNull()
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(3)
  })

  it('stops reveal retries after repeated losses in the retry window', () => {
    const pane = createPane()

    attachWebgl(pane)
    fireContextLoss(pane)
    resumePaneRendering([pane])
    fireContextLoss(pane)
    resumePaneRendering([pane])
    fireContextLoss(pane)

    schedulePaneRevealPresent(() => [pane])

    expect(pane.webglDisabledAfterContextLoss).toBe(true)
    expect(pane.webglAddon).toBeNull()
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(3)
  })
})
