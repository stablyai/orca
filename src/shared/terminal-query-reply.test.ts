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
  it('routes complete Kitty graphics acknowledgements as replies', () => {
    const ok = '\x1b_Gi=31;OK\x1b\\'
    const error = '\x1b_Gi=31,p=2;ENOENT:image not found\x1b\\'
    expect(isTerminalQueryReply(ok)).toBe(true)
    expect(isTerminalQueryReply(error)).toBe(true)
    expect(extractOnlyTerminalQueryReplies(ok + error)).toEqual([ok, error])
    expect(needsCookedEchoSafeQueryReply(ok)).toBe(false)
    for (const input of [
      '\x1b_',
      '\x1b_Gi=31;OK',
      '\x1b_Gi=31;OK\x07',
      '\x1b_Gi=31;hello\x1b\\',
      '\x1b_Ga=q,i=31;AAAA\x1b\\',
      `${ok}typed`
    ]) {
      expect(isTerminalQueryReply(input)).toBe(false)
      expect(extractOnlyTerminalQueryReplies(input)).toBeNull()
    }
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

// termenv reads one OSC-then-CPR response. If CPR overtakes the echo-deferred OSC reply, leftover ESC ] later crashes bubbletea (gh auth login).
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

  it('preserves reverse query order when CPR arrives before the color query', async () => {
    vi.useFakeTimers()
    const pty: string[] = []
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      write: (data) => pty.push(data),
      onEmission: () => {}
    })
    const write = hostWrites(ingress, pty)

    write(CPR_REPLY)
    write(OSC_11_REPLY)
    await vi.advanceTimersByTimeAsync(200)

    expect(pty).toEqual([CPR_REPLY, OSC_11_REPLY])
    ingress.drainAndClose()
    vi.useRealTimers()
  })
})
