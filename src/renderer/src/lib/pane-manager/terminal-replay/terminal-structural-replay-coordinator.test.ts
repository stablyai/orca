import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalStructuralReplayCoordinator } from './terminal-structural-replay-coordinator'
import { markTerminalPinnedViewport } from '../terminal-scroll/terminal-scroll-intent'
import '../terminal-scroll/terminal-scroll-intent-rebuild'

import '../terminal-scroll/pane-scroll'

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
