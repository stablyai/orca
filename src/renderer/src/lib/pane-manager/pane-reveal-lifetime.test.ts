// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneManager, type PaneManagerOptions } from './pane-manager'
import { getLivePaneCensus } from './pane-manager-registry'

type RevealKind = 'repaint' | 'present'

describe('pane reveal callback lifetime', () => {
  let frames: FrameRequestCallback[]
  let managers: WeakRef<PaneManager>[]

  function createManager(options: PaneManagerOptions = { linkOpenHint: () => '' }): PaneManager {
    const manager = new PaneManager(document.createElement('div'), options)
    managers.push(new WeakRef(manager))
    return manager
  }

  function schedule(manager: PaneManager, kind: RevealKind): void {
    if (kind === 'repaint') {
      manager.scheduleRevealRepaint()
    } else {
      manager.scheduleRevealPresent()
    }
  }

  function flushFrame(): void {
    const callbacks = frames
    frames = []
    for (const callback of callbacks) {
      callback(16)
    }
  }

  async function collectRetiredManagers(): Promise<void> {
    if (typeof globalThis.gc !== 'function') {
      throw new Error('Run with the repository Vitest --expose-gc config')
    }
    for (let round = 0; round < 3; round++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      globalThis.gc()
    }
  }

  function inspectPaneMap(manager: unknown): Map<unknown, unknown> {
    if (
      typeof manager !== 'object' ||
      manager === null ||
      !('panes' in manager) ||
      !(manager.panes instanceof Map)
    ) {
      throw new Error('Expected the manager pane map')
    }
    return manager.panes
  }

  function watchPaneReads(manager: PaneManager) {
    return vi.spyOn(inspectPaneMap(manager), 'values')
  }

  beforeEach(() => {
    frames = []
    managers = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    for (const ref of managers) {
      ref.deref()?.destroy()
    }
    while (frames.length > 0) {
      flushFrame()
    }
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  for (const kind of ['repaint', 'present'] as const) {
    for (const phase of ['first', 'second'] as const) {
      it(`releases a destroyed ${kind} manager while the ${phase} frame is paused`, async () => {
        const baseline = getLivePaneCensus().managers
        function retireManager() {
          const initialLayoutRef = {
            current: { buffersByLeafId: { leaf: 'restored SSH scrollback' } }
          }
          const manager = createManager({
            linkOpenHint: () => '',
            onPaneCreated: () => {
              void initialLayoutRef.current
            }
          })
          schedule(manager, kind)
          if (phase === 'second') {
            flushFrame()
          }
          manager.destroy()
          return {
            manager: new WeakRef(manager),
            layout: new WeakRef(initialLayoutRef.current)
          }
        }

        const retired = retireManager()
        expect(frames).toHaveLength(1)
        expect(getLivePaneCensus().managers).toBe(baseline)
        await collectRetiredManagers()

        expect(retired.manager.deref()).toBeUndefined()
        expect(retired.layout.deref()).toBeUndefined()
        expect(() => {
          flushFrame()
          flushFrame()
        }).not.toThrow()
      })
    }

    it(`keeps a live hidden ${kind} manager eligible after collection and reveal`, async () => {
      function scheduleHiddenManager(): WeakRef<PaneManager> {
        const manager = createManager()
        manager.setAtlasRecoveryVisible(false)
        schedule(manager, kind)
        return new WeakRef(manager)
      }
      const remembered = scheduleHiddenManager()
      await collectRetiredManagers()
      const manager = remembered.deref()
      expect(manager).toBeDefined()
      if (!manager) {
        throw new Error('The live manager registry must retain its manager')
      }
      const reads = watchPaneReads(manager)
      manager.setAtlasRecoveryVisible(true)
      flushFrame()
      expect(reads).not.toHaveBeenCalled()
      flushFrame()
      expect(reads).toHaveBeenCalledOnce()
    })

    it(`skips ${kind} pane lookup after hide or destruction`, () => {
      const hidden = createManager()
      const destroyed = createManager()
      const hiddenReads = watchPaneReads(hidden)
      const destroyedReads = watchPaneReads(destroyed)
      schedule(hidden, kind)
      schedule(destroyed, kind)
      hidden.setAtlasRecoveryVisible(false)
      destroyed.destroy()
      destroyedReads.mockClear()

      flushFrame()
      flushFrame()

      expect(hiddenReads).not.toHaveBeenCalled()
      expect(destroyedReads).not.toHaveBeenCalled()
    })

    it(`preserves ${kind} timeout scheduling without animation frames`, () => {
      vi.useFakeTimers()
      vi.stubGlobal('requestAnimationFrame', undefined)
      const manager = createManager()
      const reads = watchPaneReads(manager)
      schedule(manager, kind)
      expect(reads).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(reads).toHaveBeenCalledOnce()
    })

    it(`looks up the current ${kind} pane list after both frames settle`, () => {
      const manager = createManager()
      const panes = inspectPaneMap(manager)
      const staleVisit = vi.fn(() => false)
      const liveVisit = vi.fn(() => false)
      panes.set(1, {
        get gpuRenderingEnabled() {
          return staleVisit()
        }
      })
      schedule(manager, kind)
      flushFrame()
      panes.set(1, {
        get gpuRenderingEnabled() {
          return liveVisit()
        }
      })
      flushFrame()
      panes.clear()

      expect(staleVisit).not.toHaveBeenCalled()
      expect(liveVisit).toHaveBeenCalled()
    })
  }

  it('coalesces repeated repaint getters while preserving present callbacks', () => {
    const manager = createManager()
    const reads = watchPaneReads(manager)
    manager.scheduleRevealRepaint()
    manager.scheduleRevealRepaint()
    manager.scheduleRevealPresent()
    manager.scheduleRevealPresent()
    expect(frames).toHaveLength(3)

    flushFrame()
    expect(reads).not.toHaveBeenCalled()
    flushFrame()

    expect(reads).toHaveBeenCalledTimes(3)
  })
})
