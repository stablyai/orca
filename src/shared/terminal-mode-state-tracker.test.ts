import { describe, expect, it } from 'vitest'
import { TerminalModeStateTracker } from './terminal-mode-state-tracker'
import type { TerminalModes } from './terminal-modes'

const DEFAULT_MODES: TerminalModes = {
  bracketedPaste: false,
  mouseTracking: false,
  mouseTrackingMode: 'none',
  sgrMouseMode: false,
  sgrMousePixelsMode: false,
  applicationCursor: false,
  alternateScreen: false,
  kittyKeyboardFlags: 0
}

describe('TerminalModeStateTracker', () => {
  it('tracks DECSET mode sequences for alt screen, bracketed paste, app cursor, and mouse', () => {
    const tracker = new TerminalModeStateTracker()
    tracker.scan('\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[?1002h\x1b[?1006h')
    expect(tracker.getModes()).toEqual({
      bracketedPaste: true,
      mouseTracking: true,
      mouseTrackingMode: 'drag',
      sgrMouseMode: true,
      sgrMousePixelsMode: false,
      applicationCursor: true,
      alternateScreen: true,
      kittyKeyboardFlags: 0
    })
    tracker.scan('\x1b[?1049l\x1b[?1002l\x1b[?2004l')
    expect(tracker.getModes()).toEqual({
      ...DEFAULT_MODES,
      sgrMouseMode: true,
      applicationCursor: true
    })
  })

  it('tracks combined multi-parameter DECSET sequences', () => {
    const tracker = new TerminalModeStateTracker()
    tracker.scan('\x1b[?1;2004;1049;1003;1016h')
    expect(tracker.getModes()).toEqual({
      bracketedPaste: true,
      mouseTracking: true,
      mouseTrackingMode: 'any',
      sgrMouseMode: false,
      sgrMousePixelsMode: true,
      applicationCursor: true,
      alternateScreen: true,
      kittyKeyboardFlags: 0
    })
  })

  it('applies sequences split across chunks, including mid-introducer splits', () => {
    const stream = '\x1b[?1049h\x1b[?2004h\x1b[?1002h\x1b[?1006h'
    for (let split = 1; split < stream.length; split++) {
      const tracker = new TerminalModeStateTracker()
      tracker.scan(stream.slice(0, split))
      tracker.scan(stream.slice(split))
      expect(tracker.getModes(), `split at ${split}`).toEqual({
        bracketedPaste: true,
        mouseTracking: true,
        mouseTrackingMode: 'drag',
        sgrMouseMode: true,
        sgrMousePixelsMode: false,
        applicationCursor: false,
        alternateScreen: true,
        kittyKeyboardFlags: 0
      })
    }
  })

  it('discards a CAN/SUB-aborted sequence split across chunks instead of completing it', () => {
    for (const abort of ['\x18', '\x1a']) {
      const tracker = new TerminalModeStateTracker()
      // The DECSET is split mid-params, then aborted at the next chunk start;
      // the trailing 'h' is plain text and must not complete the aborted 1049.
      tracker.scan('\x1b[?1049')
      tracker.scan(`${abort}h\x1b[?2004h`)
      const modes = tracker.getModes()
      expect(modes.alternateScreen, JSON.stringify(abort)).toBe(false)
      expect(modes.bracketedPaste, JSON.stringify(abort)).toBe(true)
    }
  })

  it('does not corrupt mode state from an OSC string spanning chunks', () => {
    const tracker = new TerminalModeStateTracker()
    // Digit/semicolon payload split mid-string: the retained tail must stay in
    // OSC context so payload text can never be re-read as DECSET params.
    tracker.scan('\x1b]0;build 1049;2004')
    tracker.scan(';47 running\x07\x1b[?2004h')
    tracker.scan('\x1b]8;;https://example.com/1049h\x07link\x1b]8;;\x07\x1b[?1002h\x1b[?1006h')
    expect(tracker.getModes()).toEqual({
      bracketedPaste: true,
      mouseTracking: true,
      mouseTrackingMode: 'drag',
      sgrMouseMode: true,
      sgrMousePixelsMode: false,
      applicationCursor: false,
      alternateScreen: false,
      kittyKeyboardFlags: 0
    })
  })

  it('resets everything on RIS', () => {
    const tracker = new TerminalModeStateTracker()
    tracker.scan('\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[?1003h\x1b[?1006h')
    tracker.scan('\x1bc')
    expect(tracker.getModes()).toEqual(DEFAULT_MODES)
  })

  it('applies a RIS split across chunks', () => {
    const tracker = new TerminalModeStateTracker()
    tracker.scan('\x1b[?1049h\x1b[?2004h')
    tracker.scan('\x1b')
    tracker.scan('c')
    expect(tracker.getModes()).toEqual(DEFAULT_MODES)
  })

  it('resets bracketed paste and application cursor on DECSTR without leaving the alternate screen', () => {
    const tracker = new TerminalModeStateTracker()
    tracker.scan('\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[?1002h')
    tracker.scan('\x1b[!p')
    const modes = tracker.getModes()
    expect(modes.bracketedPaste).toBe(false)
    expect(modes.applicationCursor).toBe(false)
    expect(modes.alternateScreen).toBe(true)
  })

  it('continues from seeded modes', () => {
    const tracker = new TerminalModeStateTracker()
    tracker.seed({
      bracketedPaste: true,
      mouseTracking: true,
      mouseTrackingMode: 'drag',
      sgrMouseMode: true,
      sgrMousePixelsMode: false,
      applicationCursor: false,
      alternateScreen: true,
      kittyKeyboardFlags: 13
    })
    expect(tracker.getModes()).toEqual({
      bracketedPaste: true,
      mouseTracking: true,
      mouseTrackingMode: 'drag',
      sgrMouseMode: true,
      sgrMousePixelsMode: false,
      applicationCursor: false,
      alternateScreen: true,
      // Why 0: kitty flags are deliberately excluded — the post-replay kitty
      // reset stays authoritative and conformant programs re-push.
      kittyKeyboardFlags: 0
    })
    tracker.scan('\x1b[?1049l\x1b[?1002l')
    const modes = tracker.getModes()
    expect(modes.alternateScreen).toBe(false)
    expect(modes.mouseTracking).toBe(false)
    expect(modes.mouseTrackingMode).toBe('none')
    expect(modes.bracketedPaste).toBe(true)
    expect(modes.sgrMouseMode).toBe(true)
  })

  it('treats seeded state as resettable by RIS in the scanned stream', () => {
    const tracker = new TerminalModeStateTracker()
    tracker.seed({
      bracketedPaste: true,
      mouseTracking: true,
      mouseTrackingMode: 'any',
      sgrMouseMode: false,
      sgrMousePixelsMode: true,
      applicationCursor: true,
      alternateScreen: true
    })
    tracker.scan('mid-stream output\x1bc')
    expect(tracker.getModes()).toEqual(DEFAULT_MODES)
  })
})
