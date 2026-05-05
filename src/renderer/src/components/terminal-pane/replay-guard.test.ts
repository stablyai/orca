import { describe, expect, it } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { isPaneReplaying, replayIntoTerminal, type ReplayingPanesRef } from './replay-guard'

function makeRef(): ReplayingPanesRef {
  return { current: new Map() } as ReplayingPanesRef
}

type FakeTerminal = {
  write: (data: string, cb?: () => void) => void
  lastData: string[]
  pendingCallbacks: (() => void)[]
  /** Flush all pending xterm write callbacks, simulating parse completion. */
  flush: () => void
}

function makeFakePane(paneId: number): { pane: ManagedPane; terminal: FakeTerminal } {
  const pendingCallbacks: (() => void)[] = []
  const terminal: FakeTerminal = {
    lastData: [],
    pendingCallbacks,
    write(data: string, cb?: () => void) {
      terminal.lastData.push(data)
      if (cb) {
        pendingCallbacks.push(cb)
      }
    },
    flush() {
      while (pendingCallbacks.length > 0) {
        pendingCallbacks.shift()!()
      }
    }
  }
  // Only `id` and `terminal` are exercised by replayIntoTerminal.
  const pane = { id: paneId, terminal } as unknown as ManagedPane
  return { pane, terminal }
}

describe('replay-guard', () => {
  it('reports no replay for untouched pane', () => {
    const ref = makeRef()
    expect(isPaneReplaying(ref, 1)).toBe(false)
  })

  it('is replaying between write dispatch and xterm parse completion', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)

    replayIntoTerminal(pane, ref, 'hello')

    // Before xterm fires its write-completion callback, the guard is engaged —
    // this is the window during which xterm could emit auto-replies for any
    // query sequences embedded in the replayed data.
    expect(isPaneReplaying(ref, 1)).toBe(true)

    terminal.flush()
    expect(isPaneReplaying(ref, 1)).toBe(false)
  })

  it('composes nested replays via a counter', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)

    // Simulates the cold-restore path: clear preamble + scrollback + banner
    // dispatched back-to-back before xterm completes any of them.
    replayIntoTerminal(pane, ref, '\x1b[2J\x1b[3J\x1b[H')
    replayIntoTerminal(pane, ref, 'scrollback bytes')
    replayIntoTerminal(pane, ref, '--- session restored ---')
    expect(isPaneReplaying(ref, 1)).toBe(true)

    // Completion of the first write must not clear the guard — the later
    // writes are still in xterm's queue and may still auto-reply.
    terminal.pendingCallbacks.shift()!()
    expect(isPaneReplaying(ref, 1)).toBe(true)

    terminal.pendingCallbacks.shift()!()
    expect(isPaneReplaying(ref, 1)).toBe(true)

    terminal.pendingCallbacks.shift()!()
    expect(isPaneReplaying(ref, 1)).toBe(false)
  })

  it('keeps each pane independent', () => {
    const ref = makeRef()
    const a = makeFakePane(1)
    const b = makeFakePane(2)

    replayIntoTerminal(a.pane, ref, 'a')
    expect(isPaneReplaying(ref, 1)).toBe(true)
    expect(isPaneReplaying(ref, 2)).toBe(false)

    replayIntoTerminal(b.pane, ref, 'b')
    expect(isPaneReplaying(ref, 2)).toBe(true)

    a.terminal.flush()
    expect(isPaneReplaying(ref, 1)).toBe(false)
    expect(isPaneReplaying(ref, 2)).toBe(true)

    b.terminal.flush()
    expect(isPaneReplaying(ref, 2)).toBe(false)
  })

  it('skips empty data without touching the guard or xterm', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)
    replayIntoTerminal(pane, ref, '')
    expect(terminal.lastData).toEqual([])
    expect(isPaneReplaying(ref, 1)).toBe(false)
  })

  it('removes the counter entry when the last replay completes', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)
    replayIntoTerminal(pane, ref, 'x')
    terminal.flush()
    expect(ref.current.has(1)).toBe(false)
  })
})
