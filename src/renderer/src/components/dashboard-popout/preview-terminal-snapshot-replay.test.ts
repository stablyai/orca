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
})
