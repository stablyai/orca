// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { disposePane } from './pane-lifecycle'
import {
  cancelPendingViewportPresent,
  presentPaneViewport,
  presentPaneViewportPreservingSynchronizedOutput
} from './pane-viewport-present'

function frameQueue() {
  let nextId = 0
  const pending = new Map<number, FrameRequestCallback>()
  const cancel = vi.fn((id: number) => pending.delete(id))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextId
    pending.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', cancel)
  return {
    pending,
    cancel,
    flush: () => {
      for (const [id, callback] of Array.from(pending)) {
        pending.delete(id)
        callback(16)
      }
    }
  }
}

function hiddenPane(id = 1) {
  const container = document.createElement('div')
  container.style.display = 'none'
  document.body.append(container)
  const core = {
    _renderService: {
      _isPaused: true,
      _needsFullRefresh: true,
      refreshRows(_start: number, _end: number, _sync?: boolean): void {},
      _renderer: { renderRows(_start: number, _end: number): void {} }
    },
    coreService: { decPrivateModes: { synchronizedOutput: true } }
  }
  const dispose = (): void => {}
  const fixture = {
    id,
    leafId: '11111111-1111-4111-8111-111111111111',
    stablePaneId: '11111111-1111-4111-8111-111111111111',
    terminal: {
      rows: 24,
      _core: core,
      refresh(): void {},
      clearSelection(): void {},
      dispose: () => container.remove()
    },
    container,
    xtermContainer: container,
    linkTooltip: document.createElement('div'),
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: false,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    fitAddon: { dispose },
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    searchAddon: { dispose },
    serializeAddon: { dispose },
    unicode11Addon: { dispose },
    webLinksAddon: { dispose },
    webglAddon: null,
    imageAddon: null,
    ligaturesAddon: null,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every pane, terminal and addon member used by presentation and actual disposal.
  const pane = fixture as unknown as ManagedPaneInternal
  return { pane, core }
}

function closeHiddenPanes(count: number, pending: Map<number, FrameRequestCallback>) {
  const targets: { pane: WeakRef<ManagedPaneInternal>; dom: WeakRef<HTMLElement> }[] = []
  const countsAtTerminalDispose: number[] = []
  for (let id = 0; id < count; id += 1) {
    const { pane } = hiddenPane(id)
    const container = pane.container
    pane.terminal.dispose = () => {
      countsAtTerminalDispose.push(pending.size)
      container.remove()
    }
    targets.push({ pane: new WeakRef(pane), dom: new WeakRef(container) })
    const panes = new Map([[id, pane]])
    presentPaneViewport(pane)
    disposePane(pane, panes)
    expect(panes.size).toBe(0)
  }
  return { targets, countsAtTerminalDispose }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('viewport present retry lifetime', () => {
  it('releases every closed pane and DOM root while hidden frames stay suspended', async () => {
    const frames = frameQueue()
    const { targets, countsAtTerminalDispose } = closeHiddenPanes(64, frames.pending)
    if (typeof globalThis.gc !== 'function') {
      throw new Error('The test runner must enable --expose-gc')
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
    globalThis.gc()
    expect({
      callbacks: frames.pending.size,
      panes: targets.filter((target) => target.pane.deref() !== undefined).length,
      dom: targets.filter((target) => target.dom.deref() !== undefined).length
    }).toEqual({ callbacks: 0, panes: 0, dom: 0 })
    expect(countsAtTerminalDispose).toEqual(Array.from({ length: 64 }, () => 0))
  })

  it('keeps one pending retry and the existing16-frame hidden cap', () => {
    const frames = frameQueue()
    const { pane } = hiddenPane()
    const refresh = vi.spyOn(pane.terminal, 'refresh')
    presentPaneViewport(pane)
    presentPaneViewport(pane)
    expect(frames.pending.size).toBe(1)
    let callbacks = 0
    while (frames.pending.size > 0) {
      frames.flush()
      callbacks += 1
    }
    expect(callbacks).toBe(16)
    expect(refresh).toHaveBeenCalledTimes(2)
    cancelPendingViewportPresent(pane)
    expect(frames.cancel).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps synchronized-output reveal with force escalation=%s', (force) => {
    const frames = frameQueue()
    const { pane, core } = hiddenPane()
    const refresh = vi.spyOn(core._renderService, 'refreshRows')
    const direct = vi.spyOn(core._renderService._renderer, 'renderRows')
    presentPaneViewportPreservingSynchronizedOutput(pane)
    if (force) {
      presentPaneViewport(pane)
      presentPaneViewportPreservingSynchronizedOutput(pane)
    }
    expect(frames.pending.size).toBe(1)
    pane.container.style.display = 'block'
    frames.flush()
    expect(core._renderService._isPaused).toBe(false)
    expect(core._renderService._needsFullRefresh).toBe(false)
    expect(refresh.mock.calls).toEqual(force ? [] : [[0, 23, true]])
    expect(direct.mock.calls).toEqual(force ? [[0, 23]] : [])
    expect(frames.pending.size).toBe(0)
    cancelPendingViewportPresent(pane)
    expect(frames.cancel).not.toHaveBeenCalled()
  })

  it('skips captured late callbacks after cancellation and repeated cleanup', () => {
    const frames = frameQueue()
    const { pane } = hiddenPane()
    const refresh = vi.spyOn(pane.terminal, 'refresh')
    presentPaneViewport(pane)
    const queued = Array.from(frames.pending.values())
    cancelPendingViewportPresent(pane)
    cancelPendingViewportPresent(pane)
    refresh.mockClear()
    pane.container.style.display = 'block'
    for (const callback of queued) {
      callback(16)
    }
    expect(frames.pending.size).toBe(0)
    expect(refresh).not.toHaveBeenCalled()
    expect(frames.cancel).toHaveBeenCalledOnce()
  })

  it('keeps a successor retry on the same pane independent of old callbacks', () => {
    const frames = frameQueue()
    const { pane } = hiddenPane()
    presentPaneViewport(pane)
    const queued = Array.from(frames.pending.values())
    cancelPendingViewportPresent(pane)
    presentPaneViewport(pane)
    for (const callback of queued) {
      callback(16)
    }
    expect(frames.pending.size).toBe(1)
    let callbacks = 0
    while (frames.pending.size > 0) {
      frames.flush()
      callbacks += 1
    }
    expect(callbacks).toBe(16)
  })

  it('cancels only the disposed object when a replacement uses the same pane ID', () => {
    const frames = frameQueue()
    const { pane: old } = hiddenPane(7)
    const { pane: replacement } = hiddenPane(7)
    presentPaneViewport(old)
    presentPaneViewport(replacement)
    disposePane(old, new Map([[old.id, old]]))
    expect(frames.pending.size).toBe(1)
    replacement.container.style.display = 'block'
    frames.flush()
    expect(frames.pending.size).toBe(0)
    disposePane(replacement, new Map([[replacement.id, replacement]]))
    expect(frames.cancel).toHaveBeenCalledOnce()
  })

  it('detaches the old owner before cancellation can reenter and start another retry', () => {
    const frames = frameQueue()
    const { pane } = hiddenPane()
    presentPaneViewport(pane)
    frames.cancel.mockImplementationOnce((id) => {
      const callback = frames.pending.get(id)
      frames.pending.delete(id)
      presentPaneViewport(pane)
      callback?.(16)
      return true
    })
    cancelPendingViewportPresent(pane)
    expect(frames.cancel).toHaveBeenCalledOnce()
    expect(frames.pending.size).toBe(1)
    let callbacks = 0
    while (frames.pending.size > 0) {
      frames.flush()
      callbacks += 1
    }
    expect(callbacks).toBe(16)
  })

  it('drops completed IDs even when the frame shim executes synchronously', () => {
    const cancel = vi.fn()
    const request = vi.fn((callback: FrameRequestCallback) => {
      callback(16)
      return 1
    })
    vi.stubGlobal('requestAnimationFrame', request)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const { pane } = hiddenPane()
    presentPaneViewport(pane)
    expect(request).toHaveBeenCalledTimes(16)
    cancelPendingViewportPresent(pane)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('queues no fresh retry if its current visibility check disposes the pane', () => {
    const frames = frameQueue()
    const { pane, core } = hiddenPane()
    const direct = vi.spyOn(core._renderService._renderer, 'renderRows')
    const refresh = vi.spyOn(pane.terminal, 'refresh')
    const panes = new Map([[pane.id, pane]])
    presentPaneViewport(pane)
    refresh.mockClear()
    const getStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementationOnce((element, pseudoElement) => {
      disposePane(pane, panes)
      return getStyle(element, pseudoElement)
    })
    frames.flush()
    expect(panes.size).toBe(0)
    expect(frames.pending.size).toBe(0)
    expect(frames.cancel).not.toHaveBeenCalled()
    expect(direct).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
})
