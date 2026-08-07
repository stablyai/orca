import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  isTerminalWebglRetryPinnedAfterContextLosses,
  recordTerminalWebglContextLoss
} from './pane-webgl-renderer'
import { resumePaneRendering } from './pane-rendering-control'
import { setTerminalWebglDiagnosticRecorder } from '../../../../shared/terminal-webgl-diagnostics'

function createPane(): ManagedPaneInternal {
  const leafId = '33333333-3333-4333-8333-333333333333' as never
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
    // Why disabled: reattachWebglIfNeeded then no-ops, keeping these tests on
    // the pin bookkeeping instead of a real WebGL attach.
    gpuRenderingEnabled: false,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: true,
    hasComplexScriptOutput: false,
    webglAddon: null,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    pendingWebglRefreshRafId: null,
    fitAddon: {} as never,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

describe('WebGL context-loss retry pinning', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    setTerminalWebglDiagnosticRecorder(null)
    vi.useRealTimers()
  })

  it('keeps retrying below the loss threshold', () => {
    const pane = createPane()
    recordTerminalWebglContextLoss(pane)
    recordTerminalWebglContextLoss(pane)

    expect(isTerminalWebglRetryPinnedAfterContextLosses(pane)).toBe(false)
    resumePaneRendering([pane])
    expect(pane.webglDisabledAfterContextLoss).toBe(false)
  })

  it('pins the pane to the DOM renderer after repeated losses in the window', () => {
    const pane = createPane()
    recordTerminalWebglContextLoss(pane)
    recordTerminalWebglContextLoss(pane)
    recordTerminalWebglContextLoss(pane)

    expect(isTerminalWebglRetryPinnedAfterContextLosses(pane)).toBe(true)
    resumePaneRendering([pane])
    expect(pane.webglDisabledAfterContextLoss).toBe(true)
  })

  it('lets the pin decay once the loss window passes', () => {
    const pane = createPane()
    recordTerminalWebglContextLoss(pane)
    recordTerminalWebglContextLoss(pane)
    recordTerminalWebglContextLoss(pane)

    vi.advanceTimersByTime(31 * 60_000)

    expect(isTerminalWebglRetryPinnedAfterContextLosses(pane)).toBe(false)
    resumePaneRendering([pane])
    expect(pane.webglDisabledAfterContextLoss).toBe(false)
  })

  it('records the pin diagnostic once, at the threshold transition', () => {
    const recorded: string[] = []
    setTerminalWebglDiagnosticRecorder((kind) => {
      recorded.push(kind)
    })
    const pane = createPane()
    recordTerminalWebglContextLoss(pane)
    recordTerminalWebglContextLoss(pane)
    recordTerminalWebglContextLoss(pane)
    recordTerminalWebglContextLoss(pane)

    expect(recorded.filter((kind) => kind === 'webgl-context-loss-pinned-dom')).toHaveLength(1)
  })
})
