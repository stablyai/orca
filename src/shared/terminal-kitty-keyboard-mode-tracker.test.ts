import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from './terminal-kitty-keyboard-mode-tracker'
import { CONFIRMED_SHELL_MODE_RESET } from './terminal-mode-reset-profiles'

describe('TerminalKittyKeyboardModeTracker', () => {
  // Missing snapshot data must not reset already observed mode flags.
  it('treats a nullish chunk as a no-op', () => {
    const tracker = new TerminalKittyKeyboardModeTracker()
    tracker.scan('\x1b[>5u')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately passes absent snapshot data to verify the runtime guard.
    const absent = undefined as unknown as string
    expect(() => tracker.scan(absent)).not.toThrow()
    expect(() => tracker.scanReplay(absent)).not.toThrow()
    expect(tracker.flags).toBe(5)
    expect(tracker.snapshotFlags).toBe(5)
  })

  it('tracks push and pop like xterm, including the pop-to-empty zeroing', () => {
    const tracker = new TerminalKittyKeyboardModeTracker()
    tracker.scan('\x1b[>1u')
    expect(tracker.flags).toBe(1)
    tracker.scan('\x1b[>7u')
    expect(tracker.flags).toBe(7)
    tracker.scan('\x1b[<u')
    expect(tracker.flags).toBe(1)

    // Mirror xterm: draining a stack forces zero even when the popped frame held nonzero flags.
    const drained = new TerminalKittyKeyboardModeTracker()
    drained.scan('\x1b[=3;1u\x1b[>5u\x1b[<u')
    expect(drained.flags).toBe(0)
  })

  it('applies set/or/clear modes of CSI = u', () => {
    const tracker = new TerminalKittyKeyboardModeTracker()
    tracker.scan('\x1b[=1;1u')
    expect(tracker.flags).toBe(1)
    tracker.scan('\x1b[=2;2u')
    expect(tracker.flags).toBe(3)
    tracker.scan('\x1b[=1;3u')
    expect(tracker.flags).toBe(2)
    // Mode defaults to 1 (set) when omitted.
    tracker.scan('\x1b[=4u')
    expect(tracker.flags).toBe(4)
  })

  // Why: a confirmed-shell reset lands between live chunks in both records, so they must agree.
  it('agrees with xterm when the confirmed-shell reset interrupts a split live sequence', async () => {
    const term = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true } })
    const tracker = new TerminalKittyKeyboardModeTracker()
    const replies: string[] = []
    term.onData((data) => replies.push(data))
    const feed = (data: string): Promise<void> => {
      tracker.scan(data)
      return new Promise((resolve) => term.write(data, resolve))
    }
    const xtermReport = async (): Promise<string> => {
      replies.length = 0
      await new Promise<void>((resolve) => term.write('\x1b[?u', resolve))
      return replies.join('')
    }

    await feed('\x1b[>5u\x1b[?1049h\x1b[>3u\x1b[>')
    await feed(CONFIRMED_SHELL_MODE_RESET)
    await feed('1u')
    expect(tracker.flags).toBe(0)
    expect(await xtermReport()).toBe('\x1b[?0u')
    await feed('\x1b[?1049l')
    expect(tracker.flags).toBe(5)
    expect(await xtermReport()).toBe('\x1b[?5u')
    term.dispose()
  })

  it('handles sequences split across chunks and C1 CSI', () => {
    const tracker = new TerminalKittyKeyboardModeTracker()
    tracker.scan('\x1b[>')
    expect(tracker.flags).toBe(0)
    tracker.scan('1u')
    expect(tracker.flags).toBe(1)
    tracker.scan('\x9b<99u')
    expect(tracker.flags).toBe(0)
    tracker.scan('\x9b>7u')
    expect(tracker.flags).toBe(7)
  })

  it('reset() returns to the inactive state', () => {
    const tracker = new TerminalKittyKeyboardModeTracker()
    tracker.scan('\x1b[>1u\x1b[?1049h\x1b[>2u')
    tracker.reset()
    expect(tracker.flags).toBe(0)
    tracker.scan('\x1b[?1049l')
    expect(tracker.flags).toBe(0)
  })

  it('clears kitty state on DECSTR (CSI ! p) like xterm, without switching screens', () => {
    const tracker = new TerminalKittyKeyboardModeTracker()
    tracker.scan('\x1b[>1u\x1b[!p')
    expect(tracker.flags).toBe(0)

    // DECSTR clears both screen slots without switching buffers; alt exit must not resurrect flags.
    const onAlt = new TerminalKittyKeyboardModeTracker()
    onAlt.scan('\x1b[>1u\x1b[?1049h\x1b[>2u')
    expect(onAlt.flags).toBe(2)
    onAlt.scan('\x1b[!p')
    expect(onAlt.flags).toBe(0)
    onAlt.scan('\x1b[?1049l')
    expect(onAlt.flags).toBe(0)
  })

  it('handles DECSTR split across chunks', () => {
    const tracker = new TerminalKittyKeyboardModeTracker()
    tracker.scan('\x1b[>1u\x1b[!')
    expect(tracker.flags).toBe(1)
    tracker.scan('p')
    expect(tracker.flags).toBe(0)
  })

  it('applies replayed pushes as sets so redelivered windows cannot grow the stack', () => {
    const tracker = new TerminalKittyKeyboardModeTracker()
    // Two reconnects redeliver the application’s one-time push.
    tracker.scan('\x1b[>1u')
    tracker.scanReplay('\x1b[>1u')
    tracker.scanReplay('\x1b[>1u')
    expect(tracker.flags).toBe(1)
    // The TUI's single exit pop must drain to zero despite the redeliveries.
    tracker.scan('\x1b[<u')
    expect(tracker.flags).toBe(0)
  })

  it('replay scans arm a fresh tracker and honor pops inside the window', () => {
    const fresh = new TerminalKittyKeyboardModeTracker()
    fresh.scanReplay('\x1b[>1u')
    expect(fresh.flags).toBe(1)
    fresh.scan('\x1b[<u')
    expect(fresh.flags).toBe(0)

    const ranAndExited = new TerminalKittyKeyboardModeTracker()
    ranAndExited.scanReplay('\x1b[>1uoutput\x1b[<u')
    expect(ranAndExited.flags).toBe(0)
  })

  // flags is an input fallback; only snapshotFlags proves state. Republishing an unproven 0 would break bit-3 Preview input.
  describe('snapshot provenance', () => {
    it("separates a fresh PTY's known zero from a snapshot's unproven zero", () => {
      const fresh = new TerminalKittyKeyboardModeTracker()
      expect(fresh.flags).toBe(0)
      expect(fresh.snapshotFlags).toBe(0)

      fresh.resetForSnapshot()
      expect(fresh.flags).toBe(0)
      expect(fresh.snapshotFlags).toBeUndefined()
    })

    it('ignores values that are not non-negative safe integers', () => {
      const tracker = new TerminalKittyKeyboardModeTracker()
      tracker.resetForSnapshot()
      for (const invalid of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
        tracker.restoreSnapshotFlags(invalid)
        expect(tracker.snapshotFlags).toBeUndefined()
      }
    })

    it('re-proves state on an absolute set but not on a relative update', () => {
      const relative = new TerminalKittyKeyboardModeTracker()
      relative.resetForSnapshot()
      relative.scan('\x1b[=8;2u')
      expect(relative.flags).toBe(8)
      // An OR against an unproven baseline cannot prove the result.
      expect(relative.snapshotFlags).toBeUndefined()

      const absolute = new TerminalKittyKeyboardModeTracker()
      absolute.resetForSnapshot()
      absolute.scan('\x1b[=8;1u')
      expect(absolute.snapshotFlags).toBe(8)
    })

    it('degrades to unknown on a pop that reaches past omitted push history', () => {
      const tracker = new TerminalKittyKeyboardModeTracker()
      tracker.resetForSnapshot()
      tracker.restoreSnapshotFlags(8)
      tracker.scan('\x1b[<u')
      // The frame under the restored one was never captured, so zero is a guess.
      expect(tracker.flags).toBe(0)
      expect(tracker.snapshotFlags).toBeUndefined()
    })

    it('keeps a live push/pop pair proven when its baseline was proven', () => {
      const tracker = new TerminalKittyKeyboardModeTracker()
      tracker.resetForSnapshot()
      tracker.restoreSnapshotFlags(0)
      tracker.scan('\x1b[>8u')
      expect(tracker.snapshotFlags).toBe(8)
      tracker.scan('\x1b[<u')
      expect(tracker.snapshotFlags).toBe(0)
    })

    it('degrades to unknown on a pop that empties the stack over a nonzero frame', () => {
      // The app retains pre-snapshot frames; the mirror’s exhausted stack forces an unproven zero.
      const tracker = new TerminalKittyKeyboardModeTracker()
      tracker.resetForSnapshot()
      tracker.restoreSnapshotFlags(8)
      tracker.scan('\x1b[>2u\x1b[<u')
      expect(tracker.flags).toBe(0)
      expect(tracker.snapshotFlags).toBeUndefined()
    })

    it('moves the known bit with the numeric slot across screen switches', () => {
      const tracker = new TerminalKittyKeyboardModeTracker()
      tracker.resetForSnapshot()
      tracker.restoreSnapshotFlags(8)
      // The alternate screen's saved slot was never captured.
      tracker.scan('\x1b[?1049h')
      expect(tracker.snapshotFlags).toBeUndefined()
      tracker.scan('\x1b[?1049l')
      expect(tracker.snapshotFlags).toBe(8)
    })

    it('re-proves everything on RIS and DECSTR', () => {
      const ris = new TerminalKittyKeyboardModeTracker()
      ris.resetForSnapshot()
      ris.scan('\x1bc')
      expect(ris.snapshotFlags).toBe(0)

      const softReset = new TerminalKittyKeyboardModeTracker()
      softReset.resetForSnapshot()
      softReset.restoreSnapshotFlags(8)
      softReset.scan('\x1b[!p')
      expect(softReset.snapshotFlags).toBe(0)
    })
  })

  // Constructor zero is valid only from spawn; snapshot consumers need evidence before carrying it forward.
  describe('baseline grounding', () => {
    it('starts ungrounded and grounds on an explicit fresh-PTY reset', () => {
      const tracker = new TerminalKittyKeyboardModeTracker()
      expect(tracker.hasProvenBaseline).toBe(false)
      tracker.reset()
      expect(tracker.hasProvenBaseline).toBe(true)
    })

    it('is not grounded by plain output, only by absolute kitty evidence', () => {
      const tracker = new TerminalKittyKeyboardModeTracker()
      tracker.scan('plain output\x1b[31mcolored\x1b[0m')
      expect(tracker.hasProvenBaseline).toBe(false)
      tracker.scan('\x1b[>8u')
      expect(tracker.hasProvenBaseline).toBe(true)
    })

    it('grounds on a proven snapshot restore but not on the snapshot reset', () => {
      const tracker = new TerminalKittyKeyboardModeTracker()
      tracker.reset()
      tracker.resetForSnapshot()
      expect(tracker.hasProvenBaseline).toBe(false)
      tracker.restoreSnapshotFlags(8)
      expect(tracker.hasProvenBaseline).toBe(true)
    })
  })

  // Why: xterm ignores CSI u while the protocol is withheld, so the mirror must stay at 0 too.
  it('ignores kitty sequences and snapshot flags when the protocol is withheld', () => {
    const tracker = new TerminalKittyKeyboardModeTracker({ kittyKeyboard: false })
    tracker.scan('\x1b[>5u\x1b[=31u')
    expect(tracker.flags).toBe(0)
    tracker.resetForSnapshot()
    tracker.restoreSnapshotFlags(31)
    expect(tracker.flags).toBe(0)
  })
})
