import { describe, expect, it } from 'vitest'

import {
  lastAlternateScreenTransition,
  sshReconnectPaintsFromModel
} from './ssh-reattach-model-restore'

/**
 * The gate deciding whether an SSH RECONNECT repaints from main's grid or the relay byte tail.
 *
 * Worth testing directly rather than through a reattach: the inputs are a stale belief (the model's
 * alternate-screen flag, which predates the outage) and the only witness to the outage (the replay).
 * Every interesting case is a disagreement between those two, which is awkward to stage end-to-end
 * and trivial to state here.
 */
const ALT_ON = '\x1b[?1049h'
const ALT_OFF = '\x1b[?1049l'

describe('lastAlternateScreenTransition', () => {
  it('reports nothing for a replay with no screen change', () => {
    expect(lastAlternateScreenTransition('plain output\r\n$ ')).toBeNull()
    expect(lastAlternateScreenTransition('')).toBeNull()
    expect(lastAlternateScreenTransition(undefined)).toBeNull()
  })

  it('reports the LAST transition, not the first', () => {
    expect(lastAlternateScreenTransition(`${ALT_ON}frame${ALT_OFF}$ `)).toBe('exited')
    expect(lastAlternateScreenTransition(`${ALT_OFF}$ vim\r\n${ALT_ON}frame`)).toBe('entered')
  })

  it('counts the legacy 47 and 1047 modes', () => {
    // Older apps still use these, and any of the three leaving means the frame is gone.
    expect(lastAlternateScreenTransition('\x1b[?47l')).toBe('exited')
    expect(lastAlternateScreenTransition('\x1b[?1047h')).toBe('entered')
  })

  it('finds the mode inside a multi-parameter DECSET', () => {
    expect(lastAlternateScreenTransition('\x1b[?1049;1006;2004h')).toBe('entered')
  })

  it('ignores unrelated private modes', () => {
    // Bracketed paste and cursor visibility must not be read as screen changes.
    expect(lastAlternateScreenTransition('\x1b[?2004h\x1b[?25l')).toBeNull()
    // 10491 merely CONTAINS 1049 as a substring.
    expect(lastAlternateScreenTransition('\x1b[?10491h')).toBeNull()
  })

  it('still scans a tail that begins mid-escape', () => {
    // The relay tail is cut at a byte offset, so its first bytes are routinely a partial sequence.
    expect(lastAlternateScreenTransition(`49;1006h garbage ${ALT_OFF}`)).toBe('exited')
  })
})

describe('sshReconnectPaintsFromModel', () => {
  // Takes the replay as a string and derives what the gate now wants, so these cases still read as
  // "this is what the host sent" AND still run the real transition parser end to end.
  const args = (
    overrides: Partial<Omit<Parameters<typeof sshReconnectPaintsFromModel>[0], 'hasReplay'>> & {
      replay?: string
    } = {}
  ) => {
    // Key presence, not a default parameter: `replay: undefined` is a case under test — "no tail to
    // degrade to" — and a default would silently turn it back into a replay.
    const replay = 'replay' in overrides ? overrides.replay : 'some output'
    return {
      snapshot: { alternateScreen: true } as { alternateScreen?: boolean } | null,
      altFrameWouldBeSkipped: false,
      ...overrides,
      hasReplay: Boolean(replay),
      replayTransition: lastAlternateScreenTransition(replay)
    }
  }

  it('paints a full-screen app from the grid', () => {
    // The reported bug: a tail cannot rebuild a frame whose start it no longer contains.
    expect(sshReconnectPaintsFromModel(args())).toBe(true)
  })

  it('leaves a scrolling shell on the tail', () => {
    // Inverted trade: the tail holds outage output the model never saw, and the grid would drop it.
    expect(sshReconnectPaintsFromModel(args({ snapshot: { alternateScreen: false } }))).toBe(false)
    expect(sshReconnectPaintsFromModel(args({ snapshot: {} }))).toBe(false)
    expect(sshReconnectPaintsFromModel(args({ snapshot: null }))).toBe(false)
  })

  it('refuses the grid when the app LEFT the alternate screen during the outage', () => {
    // The model never consumed the outage, so it still claims alternateScreen. Painting it would
    // freeze a frame of an application that no longer exists and discard the shell's real output.
    expect(
      sshReconnectPaintsFromModel(args({ replay: `${ALT_OFF}\r\n$ echo done\r\ndone\r\n$ ` }))
    ).toBe(false)
  })

  it('keeps the grid when the app re-entered the alternate screen after leaving', () => {
    expect(sshReconnectPaintsFromModel(args({ replay: `${ALT_OFF}$ vim\r\n${ALT_ON}frame` }))).toBe(
      true
    )
  })

  it('keeps the grid when the replay says nothing about the screen', () => {
    // The common case: an idle TUI whose tail carries only redraws.
    expect(sshReconnectPaintsFromModel(args({ replay: 'redraw redraw' }))).toBe(true)
  })

  it('degrades to the tail when the alt frame would be dropped for a width mismatch', () => {
    // That guard leaves only a cleared screen for the app to repaint. A park can afford it with no
    // tail to lose; here it would mean having discarded a usable one for a blank pane.
    expect(sshReconnectPaintsFromModel(args({ altFrameWouldBeSkipped: true }))).toBe(false)
  })

  it('still paints the grid when there is no tail to degrade to', () => {
    // Both vetoes exist to protect a usable replay. With none, they would only trade a stale frame
    // for a blank one.
    expect(
      sshReconnectPaintsFromModel(args({ replay: undefined, altFrameWouldBeSkipped: true }))
    ).toBe(true)
    expect(sshReconnectPaintsFromModel(args({ replay: '', altFrameWouldBeSkipped: true }))).toBe(
      true
    )
  })

  it('refuses a normal-buffer model even with no tail', () => {
    expect(
      sshReconnectPaintsFromModel(args({ snapshot: { alternateScreen: false }, replay: '' }))
    ).toBe(false)
  })
})
