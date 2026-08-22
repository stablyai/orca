import { Terminal } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import {
  extractOnlyCookedEchoSafeQueryReplies,
  extractOnlyTerminalQueryReplies,
  isTerminalQueryReply,
  needsCookedEchoSafeQueryReply
} from './terminal-query-reply'
import { PtyStartupIngress } from './pty-startup-ingress'

describe('isTerminalQueryReply', () => {
  it('matches synthetic query replies that must be sent immediately', () => {
    // CPR cursor position report (answer to CSI 6n) — the #7329 culprit.
    expect(isTerminalQueryReply('\x1b[3;1R')).toBe(true)
    expect(isTerminalQueryReply('\x1b[22;1R')).toBe(true)
    // DSR device status.
    expect(isTerminalQueryReply('\x1b[0n')).toBe(true)
    // Contour color-scheme report (answer to CSI ?996n / mode-2031 push).
    expect(isTerminalQueryReply('\x1b[?997;1n')).toBe(true)
    expect(isTerminalQueryReply('\x1b[?997;2n')).toBe(true)
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

  it('classifies the fully framed XTVERSION reply emitted by real xterm', async () => {
    const terminal = new Terminal()
    const replies: string[] = []
    const disposable = terminal.onData((data) => replies.push(data))
    try {
      await new Promise<void>((resolve) => terminal.write('\x1b[>q', resolve))
      expect(replies).toHaveLength(1)
      const reply = replies[0]
      expect(reply.startsWith('\x1bP>|xterm.js(')).toBe(true)
      expect(reply.endsWith(')\x1b\\')).toBe(true)
      expect(isTerminalQueryReply(reply)).toBe(true)
    } finally {
      disposable.dispose()
      terminal.dispose()
    }
  })

  it('documents the accepted modified-F3/CPR collision', () => {
    // xterm.js encodes Shift+F3 as CSI 1;2R — byte-identical to a CPR report.
    // Classified as a reply on purpose: order is still preserved (the immediate
    // path flushes pending input first); see the comment in terminal-query-reply.ts.
    expect(isTerminalQueryReply('\x1b[1;2R')).toBe(true)
  })

  it('routes only cooked-echo-risk replies through the ECHO-safe write path', () => {
    // Color-scheme private DSR + OSC color — cooked prompt paint risk (#13137).
    expect(needsCookedEchoSafeQueryReply('\x1b[?997;1n')).toBe(true)
    expect(needsCookedEchoSafeQueryReply('\x1b[?997;2n')).toBe(true)
    expect(needsCookedEchoSafeQueryReply('\x1b]11;rgb:00/00/00\x07')).toBe(true)
    // Latency-critical CPR / public DSR / DA stay immediate (#7329).
    expect(needsCookedEchoSafeQueryReply('\x1b[3;1R')).toBe(false)
    expect(needsCookedEchoSafeQueryReply('\x1b[0n')).toBe(false)
    expect(needsCookedEchoSafeQueryReply('\x1b[?1;2c')).toBe(false)
    // Ordinary input must never take the echo-safe reply path.
    expect(needsCookedEchoSafeQueryReply('y')).toBe(false)
    expect(needsCookedEchoSafeQueryReply('\x1b[A')).toBe(false)
    // Dual-answerer coalesced payload is not a single reply — use extract.
    expect(needsCookedEchoSafeQueryReply('\x1b[?997;1n\x1b[?997;1n')).toBe(false)
    expect(extractOnlyCookedEchoSafeQueryReplies('\x1b[?997;1n\x1b[?997;1n')).toEqual([
      '\x1b[?997;1n',
      '\x1b[?997;1n'
    ])
    expect(extractOnlyCookedEchoSafeQueryReplies('\x1b[?997;1ny')).toBe(null)
    expect(extractOnlyTerminalQueryReplies('\x1b[?1;2c\x1b[1;1R')).toEqual([
      '\x1b[?1;2c',
      '\x1b[1;1R'
    ])
    expect(extractOnlyTerminalQueryReplies('\x1b]11;rgb:2828/2c2c/3434\x1b\\\x1b[?1;2c')).toEqual([
      '\x1b]11;rgb:2828/2c2c/3434\x1b\\',
      '\x1b[?1;2c'
    ])
    expect(extractOnlyTerminalQueryReplies('\x1b[?1;2chello')).toBe(null)
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

// Regression for the `gh auth login` report: termenv writes `OSC 11 ;? ST` then
// `CSI 6n` and reads exactly one response, treating a CPR-first answer as "no OSC
// support" without draining further. Orca defers the color reply behind an ECHO
// probe, so a CPR taken straight to the PTY overtakes it and leaves `ESC ]` in the
// tty for the next program — bubbletea then dies with
// "unexpected escape sequence from terminal: ['\x1b' ']']".
describe('query reply ordering (termenv OSC-then-CPR)', () => {
  const OSC_11_REPLY = '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\'
  const CPR_REPLY = '\x1b[1;1R'

  function hostWrites(ingress: PtyStartupIngress, pty: string[]) {
    return (data: string): void => {
      if (!ingress.answerLiveQueryReply(data)) {
        pty.push(data)
      }
    }
  }

  it('delivers the color reply before the CPR the querying program stops at', async () => {
    vi.useFakeTimers()
    const pty: string[] = []
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      write: (data) => pty.push(data),
      onEmission: () => {}
    })
    const write = hostWrites(ingress, pty)

    write(OSC_11_REPLY)
    write(CPR_REPLY)
    await vi.advanceTimersByTimeAsync(200)

    expect(pty).toEqual([OSC_11_REPLY, CPR_REPLY])
    // Nothing survives the CPR, so the next program's stdin opens clean.
    expect(pty.slice(1).join('')).not.toContain('\x1b]')
    ingress.drainAndClose()
    vi.useRealTimers()
  })

  it('keeps a CPR immediate when no color reply is deferred', () => {
    vi.useFakeTimers()
    const pty: string[] = []
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      write: (data) => pty.push(data),
      onEmission: () => {}
    })

    hostWrites(ingress, pty)(CPR_REPLY)
    expect(pty).toEqual([CPR_REPLY])
    ingress.drainAndClose()
    vi.useRealTimers()
  })

  it('never takes ordinary typed input', () => {
    const pty: string[] = []
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      write: (data) => pty.push(data),
      onEmission: () => {}
    })

    for (const keystroke of ['y', 'gh auth login\r', '\x1b[A', '\x1b', '\x03']) {
      expect(ingress.answerLiveQueryReply(keystroke)).toBe(false)
    }
    ingress.drainAndClose()
  })
})

// Known limitation, tracked for follow-up: the guarantee is FIFO among recognised
// query replies, not over every byte written to the pty. Both branches of
// takeLiveQueryReply match whole strings, so a coalesced payload is not a reply, and
// ordinary input never rides the queue at all. Pinned so the boundary is explicit —
// if a change makes these take the ordered path, that is an improvement, not a break.
describe('writes that still bypass the ordered queue', () => {
  const BYPASSING = [
    { what: 'reply coalesced with a keystroke', data: '\x1b[6;1Ry' },
    { what: 'keystroke coalesced with a reply', data: 'y\x1b[6;1R' },
    { what: 'ordinary typed input', data: 'ls\r' }
  ]

  it.each(BYPASSING)('does not take $what', ({ data }) => {
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      write: () => {},
      onEmission: () => {}
    })
    // Deferral is open, so an ordered write WOULD be queued here.
    expect(ingress.answerLiveQueryReply('\x1b]11;rgb:00/00/00\x07')).toBe(true)
    expect(ingress.answerLiveQueryReply(data)).toBe(false)
    ingress.drainAndClose()
  })
})
