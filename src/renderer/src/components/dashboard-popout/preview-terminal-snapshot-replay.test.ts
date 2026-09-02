import { describe, expect, it } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type {
  TerminalPreviewReplayChunk,
  TerminalPreviewSnapshot
} from '../../../../shared/terminal-preview'
import { replayPreviewConnectionSnapshot } from './preview-terminal-snapshot-replay'

function apply(
  snapshot: Partial<TerminalPreviewSnapshot>,
  replay: TerminalPreviewReplayChunk[] = [],
  kittyKeyboardModes = new TerminalKittyKeyboardModeTracker()
): { modes: TerminalKittyKeyboardModeTracker; written: string[] } {
  const written: string[] = []
  replayPreviewConnectionSnapshot({
    snapshot: { data: '', cols: 80, rows: 24, ...snapshot },
    replay,
    kittyKeyboardModes,
    write: (chunk, live) => {
      written.push(chunk)
      if (live) {
        kittyKeyboardModes.scan(chunk)
      } else {
        kittyKeyboardModes.scanReplay(chunk)
      }
    }
  })
  return { modes: kittyKeyboardModes, written }
}

// The Preview's mirror is the only thing that can tell the IME
// forwarder what the TUI negotiated, and snapshot ANSI never carries kitty
// pushes — so the flags have to arrive as metadata and be applied in order.
describe('replayPreviewConnectionSnapshot', () => {
  it('adopts flags the snapshot owner proved, before any live output', () => {
    const { modes } = apply({ kittyKeyboardFlags: 8 })
    expect(modes.flags).toBe(8)
    expect(modes.snapshotFlags).toBe(8)
  })

  it('leaves the mirror unproven and at the raw-text fallback when the field is absent', () => {
    const { modes } = apply({ data: 'plain output' })
    expect(modes.flags).toBe(0)
    expect(modes.snapshotFlags).toBeUndefined()

    // A later explicit negotiation still upgrades it.
    modes.scan('\x1b[>8u')
    expect(modes.flags).toBe(8)
  })

  it('replaces an earlier 8 when a replacement snapshot proves 0', () => {
    const modes = new TerminalKittyKeyboardModeTracker()
    apply({ kittyKeyboardFlags: 8 }, [], modes)
    apply({ kittyKeyboardFlags: 0 }, [], modes)
    expect(modes.flags).toBe(0)
    expect(modes.snapshotFlags).toBe(0)
  })

  it('carries live-proven flags across a resync snapshot that proves nothing', () => {
    // A grid change or capture overflow against an old host fetches a
    // replacement snapshot with no kitty metadata; wiping the mirror there
    // reintroduces the raw-text-into-a-bit-3-TUI bug on every resync.
    const modes = new TerminalKittyKeyboardModeTracker()
    apply({ data: 'first frame' }, [], modes)
    modes.scan('\x1b[>8u')
    apply({ data: 'second frame' }, [], modes)
    expect(modes.flags).toBe(8)
    expect(modes.snapshotFlags).toBe(8)
  })

  it('carries nothing across a flagless snapshot when the mirror never proved state', () => {
    // The constructor's known-zero was never proven for the previewed PTY;
    // carrying it would launder a fresh default into a host-proven inactive.
    const modes = new TerminalKittyKeyboardModeTracker()
    apply({ data: 'first frame' }, [], modes)
    apply({ data: 'second frame' }, [], modes)
    expect(modes.flags).toBe(0)
    expect(modes.snapshotFlags).toBeUndefined()
  })

  it('keeps proven flags across a replacement snapshot whose ANSI carries no kitty bytes', () => {
    // The resync path used to reset the mirror and then scan kitty-free ANSI,
    // which is what silently dropped a live TUI's negotiation.
    const modes = new TerminalKittyKeyboardModeTracker()
    apply({ data: 'first frame' }, [], modes)
    apply({ data: 'second frame', cols: 90, rows: 30, kittyKeyboardFlags: 8 }, [], modes)
    expect(modes.flags).toBe(8)
  })

  it('restores onto the screen the snapshot scan selected', () => {
    const { modes } = apply({ data: '\x1b[?1049h', kittyKeyboardFlags: 8 })
    expect(modes.isAlternateScreen).toBe(true)
    expect(modes.snapshotFlags).toBe(8)
    // Leaving the alternate screen returns to the main screen's own slot, which
    // this snapshot never proved.
    modes.scan('\x1b[?1049l')
    expect(modes.snapshotFlags).toBeUndefined()
  })

  it('advances a proven suffix with live semantics and applies redelivery idempotently', () => {
    const { modes } = apply({ kittyKeyboardFlags: 0 }, [
      { data: '\x1b[>8u', mode: 'live' },
      // A redelivered push applied as a push would leave the app's single pop
      // landing on a stale frame.
      { data: '\x1b[>8u', mode: 'replay' }
    ])
    expect(modes.flags).toBe(8)
    modes.scan('\x1b[<u')
    expect(modes.flags).toBe(0)
    expect(modes.snapshotFlags).toBe(0)
  })

  it('writes scrollback, frame, escape tail, then replay, in that order', () => {
    const { written } = apply(
      {
        scrollbackAnsi: 'history',
        data: 'frame',
        pendingEscapeTailAnsi: '\x1b['
      },
      [{ data: 'tail', mode: 'live' }]
    )
    expect(written).toEqual(['history', 'frame', '\x1b[', 'tail'])
  })
})
