import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PtyStartupIngress,
  type PtyIngressEmission,
  type PtyStartupIngressIntent
} from './pty-startup-ingress'

// Repro: on native ConPTY the PTY owner swallowed every OSC 10/11 query it could not
// answer itself, so no downstream responder (renderer xterm, headless model) ever saw it.
// Command Code v1.69 waits on OSC 11, and a ConPTY libuv stdin that never receives the
// reply stops delivering keystrokes, so the TUI accepted no input on Windows.

const COLORS = { foreground: '#2e3434', background: '#ffffff' }
const FOREGROUND_REPLY = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'
const BACKGROUND_REPLY = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
// ConPTY frames a client's startup probes between its own cursor/render sequences.
const COMMAND_CODE_CONPTY_PROBES =
  '\x1b[?25l\x1b[H\x1b]11;?\x07\x1b[?25h\x1b[?25l\x1b[?u\x1b[c\x1b[?25h'

function visible(emissions: readonly PtyIngressEmission[]): string {
  return emissions.map((emission) => emission.data).join('')
}

function conptyIngress(intent?: PtyStartupIngressIntent) {
  const writes: string[] = []
  const emissions: PtyIngressEmission[] = []
  const ingress = new PtyStartupIngress({
    ...(intent ? { intent } : {}),
    ownerBackend: 'windows-conpty',
    write: (data) => writes.push(data),
    onEmission: (emission) => emissions.push(emission)
  })
  return { ingress, writes, emissions }
}

describe('native ConPTY OSC 10/11 queries the owner cannot answer', () => {
  afterEach(() => vi.useRealTimers())

  it('reach downstream when Command Code is started from a shell pane', () => {
    const { ingress, writes, emissions } = conptyIngress()
    ingress.accept(COMMAND_CODE_CONPTY_PROBES)
    ingress.accept('\x1b]10;?\x1b\\')
    ingress.drainAndClose()

    expect(writes).toEqual([])
    expect(visible(emissions)).toBe(`${COMMAND_CODE_CONPTY_PROBES}\x1b]10;?\x1b\\`)
  })

  it('reach downstream after the agent startup window expires', () => {
    vi.useFakeTimers()
    const { ingress, writes, emissions } = conptyIngress({ colors: COLORS, deadlineMs: 5_000 })
    vi.advanceTimersByTime(5_001)
    ingress.accept(COMMAND_CODE_CONPTY_PROBES)
    ingress.drainAndClose()

    expect(writes).toEqual([])
    expect(visible(emissions)).toBe(COMMAND_CODE_CONPTY_PROBES)
  })

  it('reach downstream when the agent launch carried no usable colors', () => {
    const { ingress, writes, emissions } = conptyIngress({ colors: {}, deadlineMs: 5_000 })
    ingress.accept(COMMAND_CODE_CONPTY_PROBES)
    ingress.drainAndClose()

    expect(writes).toEqual([])
    expect(visible(emissions)).toBe(COMMAND_CODE_CONPTY_PROBES)
  })

  it('reach downstream once the owner already answered both startup slots', () => {
    const { ingress, writes, emissions } = conptyIngress({ colors: COLORS, deadlineMs: 5_000 })
    ingress.accept('\x1b]10;?\x07\x1b]11;?\x07')
    expect(writes).toEqual([FOREGROUND_REPLY, BACKGROUND_REPLY])
    ingress.accept(COMMAND_CODE_CONPTY_PROBES)
    ingress.drainAndClose()

    expect(visible(emissions)).toBe(COMMAND_CODE_CONPTY_PROBES)
  })

  it('still contains the ConPTY echo of the downstream reply', () => {
    const { ingress, writes, emissions } = conptyIngress()
    ingress.accept(COMMAND_CODE_CONPTY_PROBES)
    expect(ingress.answerLiveQueryReply(BACKGROUND_REPLY)).toBe(true)
    ingress.accept(`${BACKGROUND_REPLY.replaceAll('\x1b', '')}prompt`)
    ingress.drainAndClose()

    expect(writes).toEqual([BACKGROUND_REPLY])
    expect(visible(emissions)).toBe(`${COMMAND_CODE_CONPTY_PROBES}prompt`)
  })
})
