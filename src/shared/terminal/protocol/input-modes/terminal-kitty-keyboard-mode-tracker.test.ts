import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from './terminal-kitty-keyboard-mode-tracker'
import { CONFIRMED_SHELL_MODE_RESET } from './terminal-mode-reset-profiles'

describe('TerminalKittyKeyboardModeTracker', () => {
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

  describe('snapshot provenance', () => {
    it('degrades to unknown on a pop that empties the stack over a nonzero frame', () => {
      // The app retains pre-snapshot frames; the mirror’s exhausted stack forces an unproven zero.
      const tracker = new TerminalKittyKeyboardModeTracker()
      tracker.resetForSnapshot()
      tracker.restoreSnapshotFlags(8)
      tracker.scan('\x1b[>2u\x1b[<u')
      expect(tracker.flags).toBe(0)
      expect(tracker.snapshotFlags).toBeUndefined()
    })
  })
})
