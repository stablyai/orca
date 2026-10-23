// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachDomRendererFocusClassSync } from './pane-dom-focus-class-sync'

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
      const scheduled = Array.from(pending)
      for (const [id, callback] of scheduled) {
        pending.delete(id)
        callback(16)
      }
    }
  }
}

function captureObserver(): () => void {
  let notify = (): void => {}
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(callback: MutationCallback) {
        notify = () => callback([], this)
      }
      observe(): void {}
      disconnect(): void {}
      takeRecords(): MutationRecord[] {
        return []
      }
    }
  )
  return () => notify()
}

function terminalElement(): HTMLDivElement {
  const element = document.createElement('div')
  element.innerHTML = '<div class="xterm-rows"></div>'
  return element
}

function disposedTargets(count: number): WeakRef<HTMLElement>[] {
  const targets: WeakRef<HTMLElement>[] = []
  for (let index = 0; index < count; index += 1) {
    const element = terminalElement()
    const release = attachDomRendererFocusClassSync(element)
    targets.push(new WeakRef(element))
    release()
  }
  return targets
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('terminal DOM focus sync lifetime', () => {
  it('releases every disposed terminal DOM target while animation frames remain suspended', async () => {
    const frames = frameQueue()
    const targets = disposedTargets(64)
    if (typeof globalThis.gc !== 'function') {
      throw new Error('The test runner must enable --expose-gc')
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
    globalThis.gc()
    expect({
      callbacks: frames.pending.size,
      targets: targets.filter((target) => target.deref() !== undefined).length
    }).toEqual({ callbacks: 0, targets: 0 })
  })

  it('keeps every immediate and deferred live sync in the same order without coalescing', () => {
    const frames = frameQueue()
    const notify = captureObserver()
    const element = terminalElement()
    const rows = element.firstElementChild
    if (!rows) {
      throw new Error('missing terminal rows')
    }
    const toggle = vi.spyOn(rows.classList, 'toggle')
    const release = attachDomRendererFocusClassSync(element)
    try {
      element.classList.add('focus')
      element.dispatchEvent(new Event('focusin'))
      element.classList.remove('focus')
      notify()
      element.classList.add('focus')
      element.dispatchEvent(new Event('focusout'))
      expect(frames.pending.size).toBe(4)
      frames.flush()
      expect(toggle.mock.calls).toEqual(
        [false, true, false, true, true, true, true, true].map((focused) => [
          'xterm-focus',
          focused
        ])
      )
      expect(frames.pending.size).toBe(0)
      release()
      expect(frames.cancel).not.toHaveBeenCalled()
    } finally {
      release()
    }
  })

  it('ignores callbacks and already queued listener delivery after disposal', () => {
    const frames = frameQueue()
    const notify = captureObserver()
    const element = terminalElement()
    const add = vi.spyOn(element, 'addEventListener')
    const query = vi.spyOn(element, 'querySelector')
    const release = attachDomRendererFocusClassSync(element)
    const queued = [...frames.pending.values()]
    release()
    query.mockClear()
    for (const callback of queued) {
      callback(16)
    }
    for (const [, listener] of add.mock.calls) {
      if (typeof listener === 'function') {
        listener.call(element, new Event('focusin'))
      }
    }
    notify()
    element.dispatchEvent(new Event('focusin'))
    expect(query).not.toHaveBeenCalled()
    expect(frames.pending.size).toBe(0)
    expect(frames.cancel).toHaveBeenCalledOnce()
  })

  it('does not queue another frame when the immediate sync disposes its own owner', () => {
    const frames = frameQueue()
    captureObserver()
    const element = terminalElement()
    const release = attachDomRendererFocusClassSync(element)
    const query = element.querySelector.bind(element)
    vi.spyOn(element, 'querySelector').mockImplementation((selector) => {
      release()
      return query(selector)
    })
    element.dispatchEvent(new Event('focusin'))
    expect(frames.pending.size).toBe(0)
    expect(frames.cancel).toHaveBeenCalledOnce()
  })

  it('cancels only the old attachment when the same terminal element gets a successor', () => {
    const frames = frameQueue()
    captureObserver()
    const element = terminalElement()
    const oldRelease = attachDomRendererFocusClassSync(element)
    const oldFrames = [...frames.pending.values()]
    const release = attachDomRendererFocusClassSync(element)
    try {
      oldRelease()
      expect(frames.pending.size).toBe(1)
      for (const callback of oldFrames) {
        callback(16)
      }
      element.classList.add('focus')
      element.dispatchEvent(new Event('focusin'))
      expect(frames.pending.size).toBe(2)
      frames.flush()
      expect(element.firstElementChild?.classList.contains('xterm-focus')).toBe(true)
      release()
      expect(frames.cancel).toHaveBeenCalledOnce()
    } finally {
      oldRelease()
      release()
    }
  })

  it('keeps synchronously completed frame shims out of the pending set', () => {
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(16)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const element = terminalElement()
    const query = vi.spyOn(element, 'querySelector')
    const release = attachDomRendererFocusClassSync(element)
    expect(query).toHaveBeenCalledTimes(2)
    release()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('keeps missing elements and rows safe and releases repeated cleanup', () => {
    const frames = frameQueue()
    const missingRelease = attachDomRendererFocusClassSync(undefined)
    missingRelease()
    expect(frames.pending.size).toBe(0)
    const release = attachDomRendererFocusClassSync(document.createElement('div'))
    frames.flush()
    release()
    release()
    expect(frames.pending.size).toBe(0)
    expect(frames.cancel).not.toHaveBeenCalled()
  })
})
