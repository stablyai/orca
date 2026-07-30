import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalStructuralReplayCoordinator } from './terminal-structural-replay-coordinator'
import {
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport
} from './terminal-scroll-intent'
import {
  isTerminalScrollIntentRebuildInFlight,
  onTerminalScrollIntentBufferRebuildComplete
} from './terminal-scroll-intent-rebuild'
import { restoreScrollStateAfterFit } from './pane-scroll'
import type { ScrollState } from './pane-manager-types'

function createTerminal(viewportY: number, baseY: number) {
  const active = { type: 'normal', viewportY, baseY }
  return {
    buffer: { active },
    scrollToBottom: vi.fn(() => {
      active.viewportY = active.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      active.viewportY = line
    })
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('terminal structural replay coordinator', () => {
  it('serializes rebuilds and restores a pinned bottom offset after each parse', async () => {
    const terminal = createTerminal(80, 100)
    markTerminalPinnedViewport(terminal)
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    const firstParsed = deferred()
    const secondParsed = deferred()
    const starts: string[] = []

    const first = coordinator.run(async () => {
      starts.push('first')
      terminal.buffer.active.viewportY = 0
      terminal.buffer.active.baseY = 0
      await firstParsed.promise
      terminal.buffer.active.viewportY = 200
      terminal.buffer.active.baseY = 200
    })
    const second = coordinator.run(async () => {
      starts.push('second')
      terminal.buffer.active.viewportY = 0
      terminal.buffer.active.baseY = 0
      await secondParsed.promise
      terminal.buffer.active.viewportY = 300
      terminal.buffer.active.baseY = 300
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(starts).toEqual(['first'])
    firstParsed.resolve()
    await first
    expect(terminal.buffer.active.viewportY).toBe(180)
    await Promise.resolve()
    expect(starts).toEqual(['first', 'second'])
    secondParsed.resolve()
    await second
    expect(terminal.buffer.active.viewportY).toBe(280)
  })

  it('lets user viewport intent observed during replay supersede the old pin', async () => {
    const terminal = createTerminal(80, 100)
    markTerminalPinnedViewport(terminal)
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    const parsed = deferred()

    const completion = coordinator.run(async () => {
      terminal.buffer.active.viewportY = 0
      terminal.buffer.active.baseY = 0
      onTerminalScrollIntentBufferRebuildComplete(terminal, (completed) => {
        if (completed) {
          syncTerminalScrollIntentFromViewport(terminal, { allowBufferShrink: true })
        }
      })
      await parsed.promise
      terminal.buffer.active.viewportY = 190
      terminal.buffer.active.baseY = 200
    })

    parsed.resolve()
    await completion
    expect(terminal.buffer.active.viewportY).toBe(190)
    expect(terminal.scrollToLine).not.toHaveBeenCalled()
  })

  it('releases a rebuild on disposal without restoring a half-parsed buffer', async () => {
    const terminal = createTerminal(80, 100)
    markTerminalPinnedViewport(terminal)
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    const neverParsed = new Promise<void>(() => {})
    let postRebuildCompleted: boolean | null = null

    const completion = coordinator.run(async () => {
      terminal.buffer.active.viewportY = 0
      terminal.buffer.active.baseY = 0
      onTerminalScrollIntentBufferRebuildComplete(terminal, (completed) => {
        postRebuildCompleted = completed
      })
      await neverParsed
    })
    await Promise.resolve()
    await Promise.resolve()
    coordinator.dispose()
    await completion

    expect(postRebuildCompleted).toBe(false)
    expect(terminal.buffer.active.viewportY).toBe(0)
    expect(terminal.scrollToLine).not.toHaveBeenCalled()
  })

  it('cancels a pre-existing fit restore before replay can make it stale', async () => {
    const rafCallbacks: FrameRequestCallback[] = []
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const terminal = createTerminal(80, 100) as ReturnType<typeof createTerminal> & {
      element: object | null
    }
    terminal.element = null
    const staleState: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 20,
      baseY: 100
    }
    restoreScrollStateAfterFit(terminal as never, staleState, {
      onRestored: vi.fn(),
      shouldRestore: () => true
    })
    expect(rafCallbacks).toHaveLength(1)

    markTerminalPinnedViewport(terminal)
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    const parsed = deferred()
    const completion = coordinator.run(async () => {
      terminal.buffer.active.viewportY = 0
      terminal.buffer.active.baseY = 0
      await parsed.promise
      terminal.buffer.active.viewportY = 200
      terminal.buffer.active.baseY = 200
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)

    terminal.element = {}
    parsed.resolve()
    await completion
    expect(terminal.buffer.active.viewportY).toBe(180)
    rafCallbacks[0]?.(0)
    expect(terminal.buffer.active.viewportY).toBe(180)
  })

  it('restores and releases replay when an optional completion listener throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const terminal = createTerminal(80, 100)
    markTerminalPinnedViewport(terminal)
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    const laterCompletion = vi.fn()

    await coordinator.run(() => {
      terminal.buffer.active.viewportY = 200
      terminal.buffer.active.baseY = 200
      onTerminalScrollIntentBufferRebuildComplete(terminal, () => {
        throw new Error('optional listener failed')
      })
      onTerminalScrollIntentBufferRebuildComplete(terminal, laterCompletion)
    })

    expect(laterCompletion).toHaveBeenCalledWith(true)
    expect(terminal.buffer.active.viewportY).toBe(180)
    expect(isTerminalScrollIntentRebuildInFlight(terminal)).toBe(false)
    expect(consoleError).toHaveBeenCalledWith(
      '[terminal] scroll-intent rebuild completion failed',
      expect.any(Error)
    )
  })

  it('keeps later replay work serialized behind an asynchronous post-restore fit', async () => {
    const terminal = createTerminal(80, 100)
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    const fitCompleted = deferred()
    const fitStarted = deferred()
    const events: string[] = []

    const first = coordinator.run(
      () => {
        events.push('first-replay')
      },
      {
        afterRestore: async () => {
          events.push('first-fit')
          fitStarted.resolve()
          await fitCompleted.promise
        }
      }
    )
    const second = coordinator.run(() => {
      events.push('second-replay')
    })

    await fitStarted.promise
    expect(events).toEqual(['first-replay', 'first-fit'])
    fitCompleted.resolve()
    await first
    await second
    expect(events).toEqual(['first-replay', 'first-fit', 'second-replay'])
  })

  it('releases an asynchronous post-restore wait when the coordinator is disposed', async () => {
    const terminal = createTerminal(80, 100)
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    const fitNeverCompletes = new Promise<void>(() => {})
    const fitStarted = deferred()
    const completion = coordinator.run(() => undefined, {
      afterRestore: async () => {
        fitStarted.resolve()
        await fitNeverCompletes
      }
    })

    await fitStarted.promise
    coordinator.dispose()

    await expect(completion).resolves.toBeUndefined()
  })
})
