import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyStartupIngress } from '../../../../shared/pty-startup-ingress'
import type { PtyIngressEmission } from '../../../../shared/pty-startup-ingress'

// Reproduction for the non-agent-pane OSC 10/11 reply echo leak on POSIX.
//
// A plain shell with a prompt theme (e.g. Oh My Posh) emits OSC 10;? / 11;?
// during startup to detect the terminal's color scheme. On POSIX, the
// renderer's xterm answers the query via sendInputImmediate, but the PTY is
// still in cooked mode (the prompt theme has not entered raw mode yet), so
// readline echoes the reply as visible text:
//
//   ❭ 10;rgb:ffff/ffff/ffff11;rgb:2828/2c2c/3434
//
// The fix arms PtyStartupIngress for ALL panes (not just agent panes) by
// falling back to the terminal view-attribute store colors when
// getStartupTerminalColorQueryReplyColors returns null for non-agent panes.
// PtyStartupIngress intercepts the query on the main side, answers it, and
// suppresses the cooked echo — the renderer never sees the query or its echo.

// Oh My Posh-style startup query burst (BEL-terminated).
const OMP_STARTUP_QUERY_BURST = '\x1b]10;?\x07\x1b]11;?\x07'
// Orca's One Dark terminal theme — the values that appear in the leaked text.
const ORCA_TERMINAL_THEME = { foreground: '#ffffff', background: '#282c34' }
const OSC10_REPLY = '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'
const OSC11_REPLY = '\x1b]11;rgb:2828/2c2c/3434\x1b\\'
const LEAKED_COLOR_REPLY_TEXT = /\d\d;rgb:[0-9a-f]{4}\//

/**
 * bash/readline echo projection: `\e]` is an unbound binding, so readline eats
 * ESC + `]` and beeps, then self-inserts the rest; the ST is eaten the same way.
 */
function readlineEchoOf(reply: string): string {
  return reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')
}

function visible(emissions: readonly PtyIngressEmission[]): string {
  return emissions.map((emission) => emission.data).join('')
}

afterEach(() => vi.useRealTimers())

describe('non-agent pane OSC 10/11 reply echo leak on POSIX', () => {
  it('PtyStartupIngress with view-attribute colors suppresses the cooked echo', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    let ingress: PtyStartupIngress | undefined

    // Simulate the fix: PtyStartupIngress is armed with the terminal
    // view-attribute store colors (the same colors the renderer would use).
    ingress = new PtyStartupIngress({
      intent: { colors: ORCA_TERMINAL_THEME, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => {
        writes.push(data)
        // The PTY echoes the reply in cooked mode (readline projection).
        ingress?.accept(readlineEchoOf(data))
      },
      onEmission: (emission) => emissions.push(emission)
    })

    // OMP emits the startup query burst.
    ingress.accept(OMP_STARTUP_QUERY_BURST)
    // Why: the posix write is deferred, so advance timers to flush.
    vi.advanceTimersByTime(0)

    // The ingress answered both queries.
    expect(writes).toEqual([OSC10_REPLY, OSC11_REPLY])
    // No leaked color reply text in the visible output.
    expect(visible(emissions)).not.toMatch(LEAKED_COLOR_REPLY_TEXT)
    expect(visible(emissions)).toBe('')

    ingress.drainAndClose()
  })

  it('renders no reply text when OMP echo is coalesced with shell prompt output', () => {
    vi.useFakeTimers()
    const emitted: string[] = []
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: ORCA_TERMINAL_THEME, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emitted.push(emission.data)
    })

    // OMP emits the startup query burst.
    ingress.accept(OMP_STARTUP_QUERY_BURST)
    vi.advanceTimersByTime(0)
    expect(writes).toEqual([OSC10_REPLY, OSC11_REPLY])

    // The shell echoes the reply coalesced with its own prompt output.
    const coalescedEcho = `❭ ${writes.map(readlineEchoOf).join('')}`
    ingress.accept(coalescedEcho)
    ingress.drainAndClose()

    expect(emitted.join('')).not.toMatch(LEAKED_COLOR_REPLY_TEXT)
  })

  it('without ingress, the renderer reply echo leaks as visible text (baseline)', () => {
    // This test documents the bug: without PtyStartupIngress, the renderer
    // answers the query and the cooked echo leaks. It serves as the
    // before-fix baseline.
    vi.useFakeTimers()

    // Simulate the renderer answering the query (no ingress on main side).
    const rendererReply = (query: string): string => {
      if (query === '\x1b]10;?\x07') {
        return OSC10_REPLY
      }
      if (query === '\x1b]11;?\x07') {
        return OSC11_REPLY
      }
      return ''
    }

    // The PTY echoes the reply in cooked mode.
    const visibleOutput = OMP_STARTUP_QUERY_BURST.split('\x07')
      .filter((s) => s.startsWith('\x1b]'))
      .map((q) => `${q}\x07`)
      .map(rendererReply)
      .map(readlineEchoOf)
      .join('')

    // Without ingress, the echo leaks as visible text.
    expect(visibleOutput).toMatch(LEAKED_COLOR_REPLY_TEXT)
    expect(visibleOutput).toContain('10;rgb:ffff/ffff/ffff')
    expect(visibleOutput).toContain('11;rgb:2828/2c2c/3434')
  })
})
