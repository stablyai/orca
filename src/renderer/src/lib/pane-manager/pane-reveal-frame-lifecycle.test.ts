// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneManager } from './pane-manager'

describe('pane reveal frame ownership', () => {
  const frames = new Map<number, FrameRequestCallback>()
  const managers = new Set<PaneManager>()
  let nextFrameId = 0

  function flushFrame(): void {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) {
      callback(16)
    }
  }

  function createManager(): PaneManager {
    const manager = new PaneManager(document.createElement('div'), { linkOpenHint: () => '' })
    managers.add(manager)
    return manager
  }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  })

  afterEach(() => {
    for (const manager of managers) {
      manager.destroy()
    }
    managers.clear()
    while (frames.size > 0) {
      flushFrame()
    }
    if (vi.isFakeTimers()) {
      vi.runOnlyPendingTimers()
    }
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('releases reveal callbacks across repeated destruction while frames are withheld', () => {
    for (let index = 0; index < 32; index += 1) {
      const manager = createManager()
      manager.scheduleRevealRepaint()
      manager.scheduleRevealPresent()
      manager.destroy()
      managers.delete(manager)
    }

    expect(frames.size).toBe(0)
  })

  it.each(['scheduleRevealRepaint', 'scheduleRevealPresent'] as const)(
    'cancels the second %s frame on hide',
    (schedule) => {
      const manager = createManager()
      manager[schedule]()
      flushFrame()
      expect(frames.size).toBe(1)

      manager.setAtlasRecoveryVisible(false)

      expect(frames.size).toBe(0)
    }
  )

  it.each(['scheduleRevealRepaint', 'scheduleRevealPresent'] as const)(
    'keeps one pending %s per manager',
    (schedule) => {
      const manager = createManager()
      for (let index = 0; index < 32; index += 1) {
        manager[schedule]()
      }

      expect(frames.size).toBe(1)
      manager.destroy()
      expect(frames.size).toBe(0)
    }
  )

  it('releases the timer fallback on destruction', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', undefined)
    const manager = createManager()
    manager.scheduleRevealRepaint()
    manager.scheduleRevealPresent()

    manager.destroy()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the shared repaint frame while another manager still owns it', () => {
    const first = createManager()
    const second = createManager()
    first.scheduleRevealRepaint()
    second.scheduleRevealRepaint()

    first.destroy()
    expect(frames.size).toBe(1)
    second.destroy()
    expect(frames.size).toBe(0)
  })
})
