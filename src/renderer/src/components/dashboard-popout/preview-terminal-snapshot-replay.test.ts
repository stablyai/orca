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

// Snapshot ANSI omits kitty pushes; restore proven metadata in order before the IME forwarder reads it.
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
    // Old hosts omit kitty metadata; retain live-proven flags so resync cannot downgrade an active CSI-u TUI.
    const modes = new TerminalKittyKeyboardModeTracker()
    apply({ data: 'first frame' }, [], modes)
    modes.scan('\x1b[>8u')
    apply({ data: 'second frame' }, [], modes)
    expect(modes.flags).toBe(8)
    expect(modes.snapshotFlags).toBe(8)
  })

  it('carries nothing across a flagless snapshot when the mirror never proved state', () => {
    // Fresh default zero is not proof of this PTY’s negotiation state.
    const modes = new TerminalKittyKeyboardModeTracker()
    apply({ data: 'first frame' }, [], modes)
    apply({ data: 'second frame' }, [], modes)
    expect(modes.flags).toBe(0)
    expect(modes.snapshotFlags).toBeUndefined()
  })

  it('keeps proven flags across a replacement snapshot whose ANSI carries no kitty bytes', () => {
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
      // Redelivered pushes must not leave stale stack frames after the app’s single pop.
      { data: '\x1b[>8u', mode: 'replay' }
    ])
    expect(modes.flags).toBe(8)
    modes.scan('\x1b[<u')
    expect(modes.flags).toBe(0)
    expect(modes.snapshotFlags).toBe(0)
  })

  it('writes scrollback, frame, kitty restore, escape tail, then replay, in that order', () => {
    const { written } = apply(
      {
        scrollbackAnsi: 'history',
        data: 'frame',
        pendingEscapeTailAnsi: '\x1b['
      },
      [{ data: 'tail', mode: 'live' }]
    )
    expect(written).toEqual(['history', 'frame', '\x1b[<99u', '\x1b[', 'tail'])
  })
})
