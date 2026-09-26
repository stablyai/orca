// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { presentPaneViewportPreservingSynchronizedOutput } from './pane-viewport-present'
import { setTerminalWebglDiagnosticRecorder } from '../../../../shared/terminal-webgl-diagnostics'

const RETRY_FRAMES = 16

type Crumb = { kind: string; detail: Record<string, string | number | boolean | null> }

function createPane(): { pane: ManagedPaneInternal; host: HTMLElement; refresh: () => void } {
  const host = document.createElement('div')
  document.body.append(host)
  const refresh = vi.fn()
  const leafId = '44444444-4444-4444-8444-444444444444'
  const fake = {
    id: 7,
    leafId,
    stablePaneId: leafId,
    terminal: { cols: 80, rows: 24, refresh },
    container: host,
    xtermContainer: host,
    terminalGpuAcceleration: 'on',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    webglAddon: null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retry loop reads only container, terminal and the webgl flags; no other member is touched on this path.
  const pane = fake as unknown as ManagedPaneInternal
  return { pane, host, refresh }
}

describe('pane viewport present retry', () => {
  let rafQueue: FrameRequestCallback[] = []
  let crumbs: Crumb[] = []

  function flushFrame(): void {
    const queue = rafQueue
    rafQueue = []
    for (const callback of queue) {
      callback(16)
    }
  }

  beforeEach(() => {
    rafQueue = []
    crumbs = []
    setTerminalWebglDiagnosticRecorder((kind, detail) => {
      crumbs.push({ kind, detail: detail ?? {} })
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafQueue.push(callback)
      return rafQueue.length
    })
  })

  afterEach(() => {
    setTerminalWebglDiagnosticRecorder(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('records a breadcrumb instead of abandoning the reveal present silently', () => {
    const { pane, host } = createPane()
    host.style.display = 'none'

    presentPaneViewportPreservingSynchronizedOutput(pane)
    for (let frame = 0; frame < RETRY_FRAMES; frame += 1) {
      flushFrame()
    }

    expect(crumbs.map((crumb) => crumb.kind)).toEqual(['reveal-present-retry-abandoned'])
    expect(crumbs[0].detail).toMatchObject({
      paneId: 7,
      mode: 'preserve-synchronized-output',
      frames: RETRY_FRAMES
    })
    expect(rafQueue).toHaveLength(0)
  })

  it('reports how many frames a reveal present waited for the pane to be displayed', () => {
    const { pane, host, refresh } = createPane()
    host.style.display = 'none'

    presentPaneViewportPreservingSynchronizedOutput(pane)
    flushFrame()
    flushFrame()
    host.style.display = 'block'
    flushFrame()

    expect(crumbs.map((crumb) => crumb.kind)).toEqual(['reveal-present-retry-landed'])
    expect(crumbs[0].detail).toMatchObject({ paneId: 7, framesWaited: 2 })
    // Why: one refresh latches the pause while hidden, the second is the landed present.
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('stays quiet when the pane is already displayed on the first retry frame', () => {
    const { pane, host } = createPane()
    host.style.display = 'none'

    presentPaneViewportPreservingSynchronizedOutput(pane)
    host.style.display = 'block'
    flushFrame()

    expect(crumbs).toEqual([])
  })
})
