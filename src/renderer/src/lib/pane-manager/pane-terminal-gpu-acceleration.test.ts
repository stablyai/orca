import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal, PaneManagerOptions } from './pane-manager-types'
import { applyTerminalGpuAcceleration } from './pane-terminal-gpu-acceleration'

function createPane(): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: {
      cols: 80,
      rows: 24
    } as never,
    container: {} as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: {
      dispose: vi.fn()
    } as never,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
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

describe('applyTerminalGpuAcceleration', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(16)
      return 1
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refits after disabling WebGL so DOM renderer dimensions settle', () => {
    const pane = createPane()
    const options: PaneManagerOptions = { terminalGpuAcceleration: 'auto' }

    applyTerminalGpuAcceleration([pane], options, 'off')

    expect(pane.webglAddon).toBeNull()
    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('returns complex-script panes to DOM when switching from forced WebGL back to auto', () => {
    const pane = createPane()
    pane.hasComplexScriptOutput = true
    const options: PaneManagerOptions = { terminalGpuAcceleration: 'on' }

    applyTerminalGpuAcceleration([pane], options, 'auto')

    expect(pane.webglAddon).toBeNull()
    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('returns Linux panes to DOM when switching from forced WebGL back to auto', () => {
    vi.stubGlobal('navigator', {
      platform: 'Linux x86_64',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)'
    })
    const pane = createPane()
    const options: PaneManagerOptions = { terminalGpuAcceleration: 'on' }

    applyTerminalGpuAcceleration([pane], options, 'auto')

    expect(pane.webglAddon).toBeNull()
    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })
})
