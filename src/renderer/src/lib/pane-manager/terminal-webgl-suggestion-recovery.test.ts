import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { attachWebgl, resetTerminalWebglSuggestion } from './pane-webgl-renderer'
import { notifyPaneFitSucceeded } from './pane-fit-webgl-attach-signal'
import { resumePaneRendering, suspendPaneRendering } from './pane-rendering-control'

// xterm's WebglAddon throws this when getContext('webgl2') returns null — the
// state a restarting GPU process presents for the seconds it is unavailable.
let webglAvailable = true

function createAutoPane(id: number): ManagedPaneInternal {
  const leafId = `2222222${id}-2222-4222-8222-222222222222` as never
  const rect = { width: 800, height: 400 }
  return {
    id,
    leafId,
    stablePaneId: leafId,
    terminal: {
      cols: 80,
      rows: 24,
      refresh: vi.fn(),
      blur: vi.fn(),
      loadAddon: vi.fn(() => {
        if (!webglAvailable) {
          throw new Error('WebGL2 not supported null')
        }
      })
    } as never,
    container: { dataset: {}, getBoundingClientRect: () => rect } as never,
    xtermContainer: { getBoundingClientRect: () => rect } as never,
    // 'auto' is the shipped default, and the only mode the suggestion gates.
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: null,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    pendingWebglRefreshRafId: null,
    fitAddon: { proposeDimensions: vi.fn(() => ({ cols: 80, rows: 23 })), fit: vi.fn() } as never,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  } as never
}

describe('auto-mode WebGL suggestion expires at recovery boundaries', () => {
  beforeEach(() => {
    webglAvailable = true
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

  it('restores WebGL after a transient outage that failed one attach', () => {
    const pane = createAutoPane(1)
    attachWebgl(pane)
    expect(pane.webglAddon).not.toBeNull()

    // Backgrounded, then foregrounded while the GPU process is restarting.
    suspendPaneRendering([pane])
    webglAvailable = false
    resumePaneRendering([pane])
    expect(pane.webglAddon).toBeNull()

    // The GPU is healthy again; the next foreground must not still be on DOM.
    webglAvailable = true
    suspendPaneRendering([pane])
    resumePaneRendering([pane])

    expect(pane.webglAddon).not.toBeNull()
  })

  it('does not strand panes that never saw the failing attach', () => {
    // The regression this guards: one pane's transient failure used to pin the
    // app-wide suggestion to 'dom', so every worktree went DOM-rendered — one
    // at a time as the user visited it — for the rest of the app session.
    const failing = createAutoPane(1)
    webglAvailable = false
    attachWebgl(failing)
    webglAvailable = true

    const untouched = createAutoPane(2)
    suspendPaneRendering([untouched])
    resumePaneRendering([untouched])

    expect(untouched.webglAddon).not.toBeNull()
  })

  it('keeps a host that cannot do WebGL to one probe per boundary', () => {
    // Why this stays: retrying every pane on a WebGL-less host burns a canvas
    // and a full-stack warning each. The first failure still governs the rest
    // of the resume — only its lifetime shrinks to the boundary.
    const panes = [createAutoPane(1), createAutoPane(2), createAutoPane(3)]
    webglAvailable = false

    suspendPaneRendering(panes)
    resumePaneRendering(panes)

    const attempts = panes.filter(
      (pane) => vi.mocked(pane.terminal.loadAddon).mock.calls.length > 0
    )
    expect(attempts).toHaveLength(1)
    expect(panes.every((pane) => pane.webglAddon === null)).toBe(true)
  })

  it('leaves the suggestion in force between recovery boundaries', () => {
    // A fit is not a recovery boundary: a resize must not re-probe a GPU that
    // just refused an attach, or every title change retries context creation.
    const failing = createAutoPane(1)
    webglAvailable = false
    attachWebgl(failing)
    webglAvailable = true

    const sibling = createAutoPane(2)
    notifyPaneFitSucceeded(sibling)

    expect(sibling.webglAddon).toBeNull()
  })
})
