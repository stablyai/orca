import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyStartupIngress } from './pty-startup-ingress'
const OPENCODE_STARTUP_QUERY_BURST = '\x1b]10;?\x07\x1b]11;?\x07\x1b]4;0;?\x07'
const ORCA_TERMINAL_THEME = { foreground: '#ffffff', background: '#282c34' }
const OSC10_REPLY = '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'
const OSC11_REPLY = '\x1b]11;rgb:2828/2c2c/3434\x1b\\'
const LEAKED_COLOR_REPLY_TEXT = /\d\d;rgb:[0-9a-f]{4}\//
function readlineEchoOf(reply: string): string {
  return reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')
}

afterEach(() => vi.useRealTimers())
describe('PtyStartupIngress cooked echo reentrancy', () => {
  it('suppresses its own cooked echo on POSIX and ConPTY', () => {
    // Exercise backend cooked echoes directly without xterm or transport adaptation.
    vi.useFakeTimers()
    const forward = (ownerBackend: 'posix-pty' | 'windows-conpty') => {
      const echoOf =
        ownerBackend === 'windows-conpty'
          ? (reply: string): string => reply.replaceAll('\x1b', '')
          : readlineEchoOf
      const emitted: string[] = []
      const writes: string[] = []
      const ingress = new PtyStartupIngress({
        intent: { colors: ORCA_TERMINAL_THEME, deadlineMs: 5_000 },
        ownerBackend,
        write: (data) => {
          writes.push(data)
          ingress.accept(echoOf(data))
        },
        onEmission: (emission) => emitted.push(emission.data)
      })
      ingress.accept(OPENCODE_STARTUP_QUERY_BURST)
      // Drain the deferred POSIX write before asserting, or this arm would see no sent reply.
      vi.advanceTimersByTime(0)
      ingress.drainAndClose()
      return { visible: emitted.join(''), writes }
    }

    for (const ownerBackend of ['windows-conpty', 'posix-pty'] as const) {
      const { visible, writes } = forward(ownerBackend)
      expect(writes, ownerBackend).toEqual([OSC10_REPLY, OSC11_REPLY])
      expect(visible, ownerBackend).not.toMatch(LEAKED_COLOR_REPLY_TEXT)
    }
  })
})
