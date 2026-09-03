import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bufferPreHandlerPtyData,
  bufferPreHandlerPtyExit,
  clearConsumedPreHandlerPtyExit,
  clearPreHandlerPtyState,
  consumePreHandlerPtyState,
  currentPreHandlerPtySequence,
  drainPreHandlerPtyData,
  drainPreHandlerPtyExit,
  discardPreHandlerPtyExitFromForeignIncarnation,
  discardPreHandlerPtyState,
  discardPreHandlerPtyStateFromPriorIncarnation,
  hasPreHandlerPtyExit,
  replayPreHandlerPtyData
} from './pty-pre-handler-buffer'

const RESCAN_PTY_ID = 'pty-pre-handler-rescan'
const TRIM_PTY_ID = 'pty-pre-handler-trim'
const EXIT_PTY_ID = 'pty-pre-handler-exit'
const CAPPED_EXIT_PTY_IDS = Array.from({ length: 65 }, (_, index) => `pty-capped-exit-${index}`)
const RECYCLED_PTY_ID = 'ssh:target@@pty-2'
// Two lifetimes of the same relay-renumbered id: the shell that died while the transport was down,
// and the one the fresh spawn just got handed.
const PRIOR_INCARNATION_ID = 'incarnation-before-the-relay-restarted'
const FRESH_INCARNATION_ID = 'incarnation-of-the-shell-now-attaching'
const WARN_PTY_ID = 'pty-pre-handler-lost-handler-warn'
// One more than the buffered-data pty cap, so admitting them all evicts `WARN_PTY_ID`'s buffer.
const WARN_EVICTION_PTY_IDS = Array.from({ length: 64 }, (_, index) => `pty-warn-evict-${index}`)

describe('pre-handler PTY buffer', () => {
  afterEach(() => {
    clearPreHandlerPtyState(RESCAN_PTY_ID)
    clearPreHandlerPtyState(TRIM_PTY_ID)
    clearPreHandlerPtyState(EXIT_PTY_ID)
    for (const ptyId of CAPPED_EXIT_PTY_IDS) {
      clearPreHandlerPtyState(ptyId)
    }
    clearPreHandlerPtyState(RECYCLED_PTY_ID)
    clearPreHandlerPtyState(WARN_PTY_ID)
    for (const ptyId of WARN_EVICTION_PTY_IDS) {
      clearPreHandlerPtyState(ptyId)
    }
  })

  it('does not rescan historical chunks while buffering small startup output', () => {
    const originalReduce = Array.prototype.reduce

    try {
      Object.defineProperty(Array.prototype, 'reduce', {
        configurable: true,
        writable: true,
        value() {
          throw new Error('Array.reduce should not be used by the pre-handler PTY buffer')
        }
      })
      for (let index = 0; index < 4_096; index += 1) {
        bufferPreHandlerPtyData(RESCAN_PTY_ID, 'x')
      }
    } finally {
      Object.defineProperty(Array.prototype, 'reduce', {
        configurable: true,
        writable: true,
        value: originalReduce
      })
    }

    const drained: string[] = []
    drainPreHandlerPtyData(RESCAN_PTY_ID, (data) => drained.push(data))
    expect(drained).toHaveLength(4_096)
  })

  it('replays startup bytes without consuming the primary handler drain', () => {
    bufferPreHandlerPtyData(RESCAN_PTY_ID, 'composer frame')
    bufferPreHandlerPtyData(RESCAN_PTY_ID, '\x1b[?2004h')
    const observer = vi.fn()
    const primary = vi.fn()

    replayPreHandlerPtyData(RESCAN_PTY_ID, observer)
    drainPreHandlerPtyData(RESCAN_PTY_ID, primary)

    expect(observer.mock.calls).toEqual([['composer frame'], ['\x1b[?2004h']])
    expect(primary.mock.calls).toEqual([
      ['composer frame', undefined],
      ['\x1b[?2004h', undefined]
    ])
  })

  it('does not shift the live array while trimming a capped backlog', () => {
    const originalShift = Array.prototype.shift
    const originalWarn = console.warn

    try {
      console.warn = () => {}
      Object.defineProperty(Array.prototype, 'shift', {
        configurable: true,
        writable: true,
        value() {
          throw new Error('Array.shift should not be used by the pre-handler PTY buffer')
        }
      })
      for (let index = 0; index < 2_048; index += 1) {
        bufferPreHandlerPtyData(TRIM_PTY_ID, 'x'.repeat(1_024))
      }
    } finally {
      console.warn = originalWarn
      Object.defineProperty(Array.prototype, 'shift', {
        configurable: true,
        writable: true,
        value: originalShift
      })
    }

    const drained: string[] = []
    drainPreHandlerPtyData(TRIM_PTY_ID, (data) => drained.push(data))
    expect(drained).toHaveLength(512)
    expect(drained.join('')).toHaveLength(512 * 1_024)
  })

  it('suppresses duplicate exits after an owner consumes the pre-handler state', () => {
    const onExit = vi.fn()
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 1)
    consumePreHandlerPtyState(EXIT_PTY_ID)
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 2)

    drainPreHandlerPtyExit(EXIT_PTY_ID, onExit)
    expect(onExit).not.toHaveBeenCalled()

    bufferPreHandlerPtyData(EXIT_PTY_ID, 'reattach output')
    clearConsumedPreHandlerPtyExit(EXIT_PTY_ID)
    const data: string[] = []
    drainPreHandlerPtyData(EXIT_PTY_ID, (chunk) => data.push(chunk))
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 3)
    drainPreHandlerPtyExit(EXIT_PTY_ID, onExit)
    expect(data).toEqual(['reattach output'])
    expect(onExit).toHaveBeenCalledWith(3)
  })

  it('consumes a drained exit even when its handler throws', () => {
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 7)
    expect(() =>
      drainPreHandlerPtyExit(EXIT_PTY_ID, () => {
        throw new Error('exit handler failed')
      })
    ).toThrow('exit handler failed')

    bufferPreHandlerPtyExit(EXIT_PTY_ID, 8)
    const duplicateExit = vi.fn()
    drainPreHandlerPtyExit(EXIT_PTY_ID, duplicateExit)
    expect(duplicateExit).not.toHaveBeenCalled()
  })

  it('reports whether an undelivered exit is waiting for admission', () => {
    expect(hasPreHandlerPtyExit(EXIT_PTY_ID)).toBe(false)
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 7)
    expect(hasPreHandlerPtyExit(EXIT_PTY_ID)).toBe(true)
    drainPreHandlerPtyExit(EXIT_PTY_ID, vi.fn())
    expect(hasPreHandlerPtyExit(EXIT_PTY_ID)).toBe(false)
  })

  it('discards delayed data and exit until an explicit reconnect', () => {
    discardPreHandlerPtyState(EXIT_PTY_ID)
    bufferPreHandlerPtyData(EXIT_PTY_ID, 'late data')
    bufferPreHandlerPtyExit(EXIT_PTY_ID, 9)
    const data = vi.fn()
    const exit = vi.fn()
    drainPreHandlerPtyData(EXIT_PTY_ID, data)
    drainPreHandlerPtyExit(EXIT_PTY_ID, exit)
    expect(data).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()

    clearConsumedPreHandlerPtyExit(EXIT_PTY_ID)
    bufferPreHandlerPtyData(EXIT_PTY_ID, 'new incarnation')
    drainPreHandlerPtyData(EXIT_PTY_ID, data)
    expect(data).toHaveBeenCalledWith('new incarnation', undefined)
  })

  it('retains discard protection beyond the bounded exit-buffer capacity', () => {
    for (const ptyId of CAPPED_EXIT_PTY_IDS) {
      discardPreHandlerPtyState(ptyId)
    }

    bufferPreHandlerPtyData(CAPPED_EXIT_PTY_IDS[0], 'late data')
    bufferPreHandlerPtyExit(CAPPED_EXIT_PTY_IDS[0], 9)
    const data = vi.fn()
    const exit = vi.fn()
    drainPreHandlerPtyData(CAPPED_EXIT_PTY_IDS[0], data)
    drainPreHandlerPtyExit(CAPPED_EXIT_PTY_IDS[0], exit)
    expect(data).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('caps exits buffered without a primary handler', () => {
    for (const [code, ptyId] of CAPPED_EXIT_PTY_IDS.entries()) {
      bufferPreHandlerPtyExit(ptyId, code)
    }

    const exits: number[] = []
    for (const ptyId of CAPPED_EXIT_PTY_IDS) {
      drainPreHandlerPtyExit(ptyId, (code) => exits.push(code))
    }
    expect(exits).toHaveLength(64)
    expect(exits).not.toContain(0)
    expect(exits).toContain(64)
  })

  // A redeployed SSH relay renumbers from pty-1, so a fresh spawn is handed an id whose dead owner
  // left an exit here. Applying it reports the brand-new shell as already exited and the pane never
  // binds a PTY at all — the tab comes up blank forever.
  it("drops a recycled id's exit recorded before the fresh spawn was requested", () => {
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 0)
    bufferPreHandlerPtyData(RECYCLED_PTY_ID, 'output from the dead shell')

    const fence = currentPreHandlerPtySequence()
    discardPreHandlerPtyStateFromPriorIncarnation(RECYCLED_PTY_ID, fence)

    const exit = vi.fn()
    const data = vi.fn()
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID)).toBe(false)
    drainPreHandlerPtyExit(RECYCLED_PTY_ID, exit)
    drainPreHandlerPtyData(RECYCLED_PTY_ID, data)
    expect(exit).not.toHaveBeenCalled()
    expect(data).not.toHaveBeenCalled()
  })

  it('keeps state recorded after the fence, so a shell that dies instantly still reports its exit', () => {
    const fence = currentPreHandlerPtySequence()
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 1)
    bufferPreHandlerPtyData(RECYCLED_PTY_ID, 'startup bytes')

    discardPreHandlerPtyStateFromPriorIncarnation(RECYCLED_PTY_ID, fence)

    const exit = vi.fn()
    const data = vi.fn()
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID)).toBe(true)
    // Data first: draining the exit transfers ownership and clears the buffered bytes with it.
    drainPreHandlerPtyData(RECYCLED_PTY_ID, data)
    drainPreHandlerPtyExit(RECYCLED_PTY_ID, exit)
    expect(exit).toHaveBeenCalledWith(1)
    expect(data).toHaveBeenCalledWith('startup bytes', undefined)
  })

  // A buffer can hold both owners' bytes: the dead shell's output is still queued when our own
  // first chunk arrives while the spawn reply is in flight. Dating the buffer by its newest chunk
  // makes that one chunk of ours vouch for all of them, and the new terminal opens showing the
  // dead PTY's output above its own.
  it("keeps only our own bytes when a recycled id's buffer holds both owners' output", () => {
    bufferPreHandlerPtyData(RECYCLED_PTY_ID, 'output from the dead shell')
    const fence = currentPreHandlerPtySequence()
    bufferPreHandlerPtyData(RECYCLED_PTY_ID, 'our startup bytes')

    discardPreHandlerPtyStateFromPriorIncarnation(RECYCLED_PTY_ID, fence)

    const seen: string[] = []
    drainPreHandlerPtyData(RECYCLED_PTY_ID, (data) => seen.push(data))
    expect(seen).toEqual(['our startup bytes'])
  })

  // The case the sequence fence structurally cannot reach: the stale exit is recorded AFTER the
  // renderer asked for a fresh PTY, so it is newer than the fence and passes it. Only the
  // incarnation says the exit describes a lifetime of the id that ended before this one began.
  it("drops a recycled id's exit that arrived after the spawn request, on incarnation alone", () => {
    const fence = currentPreHandlerPtySequence()
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 0, PRIOR_INCARNATION_ID)

    discardPreHandlerPtyExitFromForeignIncarnation(RECYCLED_PTY_ID, FRESH_INCARNATION_ID)
    discardPreHandlerPtyStateFromPriorIncarnation(RECYCLED_PTY_ID, fence)

    const exit = vi.fn()
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID)).toBe(false)
    drainPreHandlerPtyExit(RECYCLED_PTY_ID, exit)
    expect(exit).not.toHaveBeenCalled()
  })

  it('keeps a post-fence exit from the incarnation that is attaching, so an instantly dead shell still reports', () => {
    const fence = currentPreHandlerPtySequence()
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 1, FRESH_INCARNATION_ID)

    discardPreHandlerPtyExitFromForeignIncarnation(RECYCLED_PTY_ID, FRESH_INCARNATION_ID)
    discardPreHandlerPtyStateFromPriorIncarnation(RECYCLED_PTY_ID, fence)

    const exit = vi.fn()
    drainPreHandlerPtyExit(RECYCLED_PTY_ID, exit)
    expect(exit).toHaveBeenCalledWith(1)
  })

  // Absence is unknown, never a mismatch: a host that predates the field, and the relay's own
  // `{ id, code: -1 }` stale-PTY drop, must keep the fence's behaviour exactly.
  it('never discards on incarnation when either side is unnamed', () => {
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 2)
    discardPreHandlerPtyExitFromForeignIncarnation(RECYCLED_PTY_ID, FRESH_INCARNATION_ID)
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID)).toBe(true)
    drainPreHandlerPtyExit(RECYCLED_PTY_ID, vi.fn())

    clearConsumedPreHandlerPtyExit(RECYCLED_PTY_ID)
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 3, PRIOR_INCARNATION_ID)
    discardPreHandlerPtyExitFromForeignIncarnation(RECYCLED_PTY_ID, undefined)
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID)).toBe(true)
  })

  // The identity rule is about exits only. `pty:data` carries no incarnation, so buffered bytes
  // stay on the sequence fence and must survive a discard that rejects an exit beside them.
  it('leaves buffered bytes alone when it discards a foreign exit', () => {
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 0, PRIOR_INCARNATION_ID)
    bufferPreHandlerPtyData(RECYCLED_PTY_ID, 'startup bytes')

    discardPreHandlerPtyExitFromForeignIncarnation(RECYCLED_PTY_ID, FRESH_INCARNATION_ID)

    const data = vi.fn()
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID)).toBe(false)
    drainPreHandlerPtyData(RECYCLED_PTY_ID, data)
    expect(data).toHaveBeenCalledWith('startup bytes', undefined)
  })

  // The intersection of the two races this buffer exists for: the shell we just spawned dies before
  // the pane attaches, AND the relay flushes the previous owner's exit for the same recycled id
  // afterwards. Keyed on the id alone, the stranger overwrites our own exit and the identity discard
  // then removes the only survivor — a pane bound to a PTY that is dead and never reported dead.
  it("keeps our own pre-attach exit when a late stranger's exit lands on the same recycled id", () => {
    const fence = currentPreHandlerPtySequence()
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 1, FRESH_INCARNATION_ID)
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 0, PRIOR_INCARNATION_ID)

    discardPreHandlerPtyExitFromForeignIncarnation(RECYCLED_PTY_ID, FRESH_INCARNATION_ID)
    discardPreHandlerPtyStateFromPriorIncarnation(RECYCLED_PTY_ID, fence)

    const exit = vi.fn()
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID)).toBe(true)
    drainPreHandlerPtyExit(RECYCLED_PTY_ID, exit)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('replaces a duplicate exit for the same lifetime instead of crowding out another lifetime', () => {
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 1, FRESH_INCARNATION_ID)
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 9, FRESH_INCARNATION_ID)
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 0, PRIOR_INCARNATION_ID)

    discardPreHandlerPtyExitFromForeignIncarnation(RECYCLED_PTY_ID, FRESH_INCARNATION_ID)

    const exit = vi.fn()
    drainPreHandlerPtyExit(RECYCLED_PTY_ID, exit)
    expect(exit).toHaveBeenCalledWith(9)
  })

  // Reads are filtered by lifetime inside the buffer, so a consumer that never calls the discard —
  // a background launch registering an eager buffer straight off its own spawn — still cannot be
  // handed the previous owner's exit and tear its freshly started session down.
  it('never reports or delivers a foreign exit to a reader that names its lifetime', () => {
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 0, PRIOR_INCARNATION_ID)

    const exit = vi.fn()
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID, FRESH_INCARNATION_ID)).toBe(false)
    drainPreHandlerPtyExit(RECYCLED_PTY_ID, exit, FRESH_INCARNATION_ID)
    expect(exit).not.toHaveBeenCalled()

    // A reader with no incarnation still sees it: absence is unknown, so it has nothing to judge by.
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID)).toBe(true)
  })

  // A malformed incarnation is evidence of nothing. Treating it as a value that disagrees with
  // everything would discard the very exits the buffer exists to deliver.
  it('treats a malformed incarnation as unknown rather than as a disagreement', () => {
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 4, { not: 'a string' })
    discardPreHandlerPtyExitFromForeignIncarnation(RECYCLED_PTY_ID, FRESH_INCARNATION_ID)
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID)).toBe(true)
    drainPreHandlerPtyExit(RECYCLED_PTY_ID, vi.fn())

    clearConsumedPreHandlerPtyExit(RECYCLED_PTY_ID)
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 5, PRIOR_INCARNATION_ID)
    discardPreHandlerPtyExitFromForeignIncarnation(RECYCLED_PTY_ID, 42)
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID)).toBe(true)
  })

  // Why these three: the lost-handler diagnostic is latched so a buffer already over the threshold
  // does not warn on every chunk. The latch describes ONE buffering episode, but a pty id is reused
  // over time and its byte count falls as well as rises, so every way the count comes back down has
  // to re-arm it or the replacement PTY's own accumulation goes unreported.
  it('warns again once the spawn fence drops the prior owner below the threshold', () => {
    const warn = vi.fn()
    const originalWarn = console.warn
    console.warn = warn

    try {
      bufferPreHandlerPtyData(WARN_PTY_ID, 'a'.repeat(70 * 1_024))
      const fence = currentPreHandlerPtySequence()
      bufferPreHandlerPtyData(WARN_PTY_ID, 'b'.repeat(1_024))
      discardPreHandlerPtyStateFromPriorIncarnation(WARN_PTY_ID, fence)
      bufferPreHandlerPtyData(WARN_PTY_ID, 'c'.repeat(70 * 1_024))
    } finally {
      console.warn = originalWarn
    }

    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('warns again after the byte cap trims the buffer back under the threshold', () => {
    const warn = vi.fn()
    const originalWarn = console.warn
    console.warn = warn

    try {
      bufferPreHandlerPtyData(WARN_PTY_ID, 'a'.repeat(500 * 1_024))
      bufferPreHandlerPtyData(WARN_PTY_ID, 'b'.repeat(20 * 1_024))
      bufferPreHandlerPtyData(WARN_PTY_ID, 'c'.repeat(70 * 1_024))
    } finally {
      console.warn = originalWarn
    }

    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('warns again for an id whose buffer was evicted at the pty cap', () => {
    const warn = vi.fn()
    const originalWarn = console.warn
    console.warn = warn

    try {
      bufferPreHandlerPtyData(WARN_PTY_ID, 'a'.repeat(70 * 1_024))
      for (const ptyId of WARN_EVICTION_PTY_IDS) {
        bufferPreHandlerPtyData(ptyId, 'x')
      }
      bufferPreHandlerPtyData(WARN_PTY_ID, 'c'.repeat(70 * 1_024))
    } finally {
      console.warn = originalWarn
    }

    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('re-admits exits for a recycled id whose prior incarnation was consumed', () => {
    consumePreHandlerPtyState(RECYCLED_PTY_ID)

    discardPreHandlerPtyStateFromPriorIncarnation(RECYCLED_PTY_ID, currentPreHandlerPtySequence())
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 3)

    const exit = vi.fn()
    drainPreHandlerPtyExit(RECYCLED_PTY_ID, exit)
    expect(exit).toHaveBeenCalledWith(3)
  })
})
