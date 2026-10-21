// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import type { ManagedPaneInternal } from './pane-manager-types'
import { disposePane } from './pane-lifecycle'
import { toPublicPane } from './pane-public-view'
import {
  cancelPendingTerminalViewportPresents,
  presentPaneViewport,
  presentPaneViewportPreservingSynchronizedOutput
} from './pane-viewport-present'
import {
  forceFullViewportPresent,
  requestFullViewportPresent
} from './terminal-render-pause-release'

vi.mock('./terminal-render-pause-release', () => ({
  forceFullViewportPresent: vi.fn(() => false),
  requestFullViewportPresent: vi.fn(() => false)
}))

describe('pane viewport retry lifetime', () => {
  let frames: Map<number, FrameRequestCallback>
  let nextFrameId: number
  let panes: WeakRef<ManagedPaneInternal>[]

  function createPane(): ManagedPaneInternal {
    const leafId = '11111111-1111-4111-8111-111111111111'
    if (!isTerminalLeafId(leafId)) {
      throw new Error('Expected a valid fixture leaf id')
    }
    const container = document.createElement('div')
    container.style.display = 'none'
    document.body.appendChild(container)
    const pane: ManagedPaneInternal = {
      id: 1,
      leafId,
      stablePaneId: leafId,
      terminal: new Terminal({ cols: 128, rows: 24, scrollback: 5000, allowProposedApi: true }),
      container,
      xtermContainer: container,
      linkTooltip: document.createElement('div'),
      fitAddon: new FitAddon(),
      searchAddon: new SearchAddon(),
      serializeAddon: new SerializeAddon(),
      unicode11Addon: new Unicode11Addon(),
      webLinksAddon: new WebLinksAddon(),
      terminalGpuAcceleration: 'off',
      gpuRenderingEnabled: false,
      webglAttachmentDeferred: false,
      webglDisabledAfterContextLoss: false,
      hasComplexScriptOutput: false,
      webglAddon: null,
      imageAddon: null,
      ligaturesAddon: null,
      fitResizeObserver: null,
      pendingObservedFitRafId: null,
      compositionHandler: null,
      pendingSplitScrollState: null,
      debugLabel: null
    }
    panes.push(new WeakRef(pane))
    return pane
  }

  function flushFrame(): void {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) {
      callback(16)
    }
  }

  beforeEach(() => {
    frames = new Map()
    nextFrameId = 0
    panes = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  })

  afterEach(() => {
    for (const ref of panes) {
      const pane = ref.deref()
      if (pane) {
        disposePane(pane, new Map([[pane.id, pane]]))
        pane.container.remove()
      }
    }
    frames.clear()
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  for (const present of [presentPaneViewport, presentPaneViewportPreservingSynchronizedOutput]) {
    for (const elapsed of [0, 3]) {
      it(`cancels every public-wrapper retry after ${elapsed} ticks`, () => {
        const pane = createPane()
        present(toPublicPane(pane))
        present(toPublicPane(pane))
        for (let tick = 0; tick < elapsed; tick++) {
          flushFrame()
        }
        expect(frames.size).toBe(2)
        const lateCallbacks = [...frames.values()]
        disposePane(pane, new Map([[pane.id, pane]]))
        expect(frames.size).toBe(0)
        for (const callback of lateCallbacks) {
          callback(16)
        }
        expect(frames.size).toBe(0)
      })
    }
  }

  it('releases real disposed xterm buffers before paused frames resume', async () => {
    async function retireTerminal(): Promise<WeakRef<Terminal>> {
      const pane = createPane()
      await new Promise<void>((resolve) =>
        pane.terminal.write('retained history\r\n'.repeat(500), resolve)
      )
      presentPaneViewport(toPublicPane(pane))
      presentPaneViewportPreservingSynchronizedOutput(toPublicPane(pane))
      flushFrame()
      disposePane(pane, new Map([[pane.id, pane]]))
      pane.container.remove()
      return new WeakRef(pane.terminal)
    }
    const retired = await retireTerminal()
    if (typeof globalThis.gc !== 'function') {
      throw new Error('Run with the repository Vitest --expose-gc config')
    }
    for (let round = 0; round < 4; round++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      globalThis.gc()
    }
    expect(retired.deref()).toBeUndefined()
    expect(frames.size).toBe(0)
  })

  it('keeps a different live terminal retry eligible when one is disposed', () => {
    const retired = createPane()
    const live = createPane()
    presentPaneViewport(toPublicPane(retired))
    presentPaneViewportPreservingSynchronizedOutput(toPublicPane(live))
    disposePane(retired, new Map([[retired.id, retired]]))
    expect(frames.size).toBe(1)
    live.container.style.display = 'block'
    flushFrame()
    expect(requestFullViewportPresent).toHaveBeenCalledWith(live.terminal)
    expect(forceFullViewportPresent).not.toHaveBeenCalled()
  })

  it('deduplicates the same wrapper and upgrades its force mode', () => {
    const pane = createPane()
    const view = toPublicPane(pane)
    presentPaneViewportPreservingSynchronizedOutput(view)
    presentPaneViewport(view)
    expect(frames.size).toBe(1)
    pane.container.style.display = 'block'
    flushFrame()
    expect(forceFullViewportPresent).toHaveBeenCalledOnce()
    expect(requestFullViewportPresent).not.toHaveBeenCalled()
  })

  it('preserves the sixteen-frame budget for a live collapsed pane', () => {
    const pane = createPane()
    presentPaneViewport(toPublicPane(pane))
    for (let tick = 0; tick < 15; tick++) {
      flushFrame()
      expect(frames.size).toBe(1)
    }
    flushFrame()
    expect(frames.size).toBe(0)
    pane.container.style.display = 'block'
    presentPaneViewport(toPublicPane(pane))
    expect(forceFullViewportPresent).toHaveBeenCalledOnce()
  })

  it('keeps immediate displayed presentation and the no-frame fallback', () => {
    const pane = createPane()
    pane.container.style.display = 'block'
    presentPaneViewportPreservingSynchronizedOutput(toPublicPane(pane))
    expect(requestFullViewportPresent).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
    pane.container.style.display = 'none'
    vi.stubGlobal('requestAnimationFrame', undefined)
    const refresh = vi.spyOn(pane.terminal, 'refresh')
    presentPaneViewport(toPublicPane(pane))
    expect(refresh).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
  })

  it('allows a cancelled live wrapper to schedule again', () => {
    const pane = createPane()
    const view = toPublicPane(pane)
    presentPaneViewport(view)
    cancelPendingTerminalViewportPresents(pane.terminal)
    expect(frames.size).toBe(0)
    presentPaneViewport(view)
    expect(frames.size).toBe(1)
  })
})
