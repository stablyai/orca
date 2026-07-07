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
    // DECRPM mode report.
    expect(isTerminalQueryReply('\x1b[?2026;2$y')).toBe(true)
    // OSC 10/11 color responses (the #7329 culprit) — BEL and ST terminated.
    expect(isTerminalQueryReply('\x1b]11;rgb:2828/2c2c/3434\x1b\\')).toBe(true)
    expect(isTerminalQueryReply('\x1b]10;rgb:c0c0/c0c0/c0c0\x07')).toBe(true)
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
    // Alt+key.
    expect(isTerminalQueryReply('\x1bb')).toBe(false)
    // Bracketed paste markers are input framing, not replies.
    expect(isTerminalQueryReply('\x1b[200~')).toBe(false)
    expect(isTerminalQueryReply('\x1b[201~')).toBe(false)
    // Incomplete / non-terminated OSC must not match.
    expect(isTerminalQueryReply('\x1b]11;rgb:2828/2c2c/3434')).toBe(false)
  })
})
