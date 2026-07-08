import { describe, expect, it } from 'vitest'
import { isTerminalQueryReply } from './terminal-query-reply'

describe('isTerminalQueryReply', () => {
  it('matches synthetic query replies that must be sent immediately', () => {
    // CPR cursor position report (answer to CSI 6n) — the #7329 culprit.
    expect(isTerminalQueryReply('\x1b[3;1R')).toBe(true)
    expect(isTerminalQueryReply('\x1b[22;1R')).toBe(true)
    // DSR device status.
    expect(isTerminalQueryReply('\x1b[0n')).toBe(true)
    // DA1/DA2/DA3 device attributes.
    expect(isTerminalQueryReply('\x1b[?1;2c')).toBe(true)
    expect(isTerminalQueryReply('\x1b[?61;4c')).toBe(true)
    expect(isTerminalQueryReply('\x1b[>0;276;0c')).toBe(true)
    // Window/cell pixel-size reports.
    expect(isTerminalQueryReply('\x1b[6;16;8t')).toBe(true)
    expect(isTerminalQueryReply('\x1b[4;384;640t')).toBe(true)
    // DECRPM mode report — private (with ?) and ANSI (without ?).
    expect(isTerminalQueryReply('\x1b[?2026;2$y')).toBe(true)
    expect(isTerminalQueryReply('\x1b[4;1$y')).toBe(true)
    // OSC 10/11 color responses (the #7329 culprit) — BEL and ST terminated.
    expect(isTerminalQueryReply('\x1b]11;rgb:2828/2c2c/3434\x1b\\')).toBe(true)
    expect(isTerminalQueryReply('\x1b]10;rgb:c0c0/c0c0/c0c0\x07')).toBe(true)
    // DECXCPR extended cursor position report (answer to CSI ? 6n).
    expect(isTerminalQueryReply('\x1b[?12;5R')).toBe(true)
    // Text-area size in characters (answer to CSI 18t).
    expect(isTerminalQueryReply('\x1b[8;24;80t')).toBe(true)
    // Kitty keyboard flags report (answer to CSI ? u) — crossterm probes this
    // at startup, so a debounced reply corrupts the same way CPR did.
    expect(isTerminalQueryReply('\x1b[?0u')).toBe(true)
    expect(isTerminalQueryReply('\x1b[?31u')).toBe(true)
    // DCS DECRQSS reports (vim queries cursor style via DCS $ q) + XTVERSION.
    expect(isTerminalQueryReply('\x1bP1$r2 q\x1b\\')).toBe(true)
    expect(isTerminalQueryReply('\x1bP1$r0m\x1b\\')).toBe(true)
    expect(isTerminalQueryReply('\x1bP0$r\x1b\\')).toBe(true)
    expect(isTerminalQueryReply('\x1bP>|xterm.js(5.6.0)\x1b\\')).toBe(true)
  })

  it('documents the accepted modified-F3/CPR collision', () => {
    // xterm.js encodes Shift+F3 as CSI 1;2R — byte-identical to a CPR report.
    // Classified as a reply on purpose: order is still preserved (the immediate
    // path flushes pending input first); see the comment in terminal-query-reply.ts.
    expect(isTerminalQueryReply('\x1b[1;2R')).toBe(true)
  })

  it('does NOT match ordinary typed input or navigation sequences', () => {
    // Plain text.
    expect(isTerminalQueryReply('yes')).toBe(false)
    expect(isTerminalQueryReply('y')).toBe(false)
    expect(isTerminalQueryReply('\r')).toBe(false)
    expect(isTerminalQueryReply('\x03')).toBe(false) // Ctrl-C
    // Arrow keys / navigation — must stay batched (coalesced auto-repeat).
    expect(isTerminalQueryReply('\x1b[A')).toBe(false)
    expect(isTerminalQueryReply('\x1b[B')).toBe(false)
    expect(isTerminalQueryReply('\x1b[C')).toBe(false)
    expect(isTerminalQueryReply('\x1b[D')).toBe(false)
    expect(isTerminalQueryReply('\x1b[H')).toBe(false) // Home
    expect(isTerminalQueryReply('\x1b[F')).toBe(false) // End
    // Function keys (end in ~).
    expect(isTerminalQueryReply('\x1b[15~')).toBe(false)
    expect(isTerminalQueryReply('\x1b[3~')).toBe(false) // Delete
    // Bare Escape key.
    expect(isTerminalQueryReply('\x1b')).toBe(false)
    // Alt+key (including Alt+Shift+P, whose bytes prefix the DCS grammar).
    expect(isTerminalQueryReply('\x1bb')).toBe(false)
    expect(isTerminalQueryReply('\x1bP')).toBe(false)
    // Kitty-protocol KEYSTROKES (CSI code;mods u, no "?") must stay batched.
    expect(isTerminalQueryReply('\x1b[97;5u')).toBe(false)
    expect(isTerminalQueryReply('\x1b[13u')).toBe(false)
    // Modified F1/F2/F4 (CSI 1;<mod> P/Q/S) are keystrokes, not replies.
    expect(isTerminalQueryReply('\x1b[1;2P')).toBe(false)
    expect(isTerminalQueryReply('\x1b[1;2Q')).toBe(false)
    expect(isTerminalQueryReply('\x1b[1;2S')).toBe(false)
    // Bracketed paste markers are input framing, not replies.
    expect(isTerminalQueryReply('\x1b[200~')).toBe(false)
    expect(isTerminalQueryReply('\x1b[201~')).toBe(false)
    // Incomplete / non-terminated OSC and DCS must not match.
    expect(isTerminalQueryReply('\x1b]11;rgb:2828/2c2c/3434')).toBe(false)
    expect(isTerminalQueryReply('\x1bP1$r2 q')).toBe(false)
  })
})
