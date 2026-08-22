// Live query replies: written in the caller's turn, with their echo shapes armed.
// Withholding used to live here (#13137); it was deleted because deferring the write is
// what let one reply overtake another and land in the next program's stdin (#15559).
import { describe, expect, it } from 'vitest'
import { PtyStartupIngress, type PtyIngressEmission } from './pty-startup-ingress'
import { mode2031SequenceFor } from './terminal-color-scheme-protocol'
import {
  extractOnlyCookedEchoSafeQueryReplies,
  needsCookedEchoSafeQueryReply
} from './terminal-query-reply'

const COLOR_SCHEME_REPLY = mode2031SequenceFor('dark')
const OSC_COLOR_REPLY = '\x1b]11;rgb:00/00/00\x07'
const CPR_REPLY = '\x1b[6;1R'
const DA1_REPLY = '\x1b[?1;2c'
const caretEcho = (reply: string): string => reply.replaceAll('\x1b', '^[')
const readlineEcho = (reply: string): string =>
  reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')

function harness(): {
  ingress: PtyStartupIngress
  writes: string[]
  emissions: PtyIngressEmission[]
} {
  const writes: string[] = []
  const emissions: PtyIngressEmission[] = []
  const ingress = new PtyStartupIngress({
    ownerBackend: 'posix-pty',
    write: (data) => void writes.push(data),
    onEmission: (emission) => void emissions.push(emission)
  })
  return { ingress, writes, emissions }
}

const visible = (emissions: readonly PtyIngressEmission[]): string =>
  emissions.map((emission) => emission.data).join('')

describe('live query replies', () => {
  it('classifies the real mode-2031 reply as cooked-echo-risk', () => {
    expect(COLOR_SCHEME_REPLY).toBe('\x1b[?997;1n')
    expect(needsCookedEchoSafeQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    expect(needsCookedEchoSafeQueryReply(mode2031SequenceFor('light'))).toBe(true)
  })

  it('writes an echo-risk reply in the calling turn', () => {
    const { ingress, writes } = harness()
    expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
    // No timer advance: the whole point is that there is nothing to wait for.
    expect(writes).toEqual([OSC_COLOR_REPLY])
    ingress.drainAndClose()
  })

  it('answers repeated identical replies without collapsing them', () => {
    const { ingress, writes } = harness()
    expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    expect(writes).toEqual([COLOR_SCHEME_REPLY, COLOR_SCHEME_REPLY])
    ingress.drainAndClose()
  })

  it('swallows the caret echo of a live DSR reply', () => {
    let ingress!: PtyStartupIngress
    const emissions: PtyIngressEmission[] = []
    ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      write: (data) => ingress.accept(caretEcho(data)),
      onEmission: (emission) => void emissions.push(emission)
    })
    expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    expect(visible(emissions)).toBe('')

    ingress.accept('Ok to proceed? (y) ')
    expect(visible(emissions)).toBe('Ok to proceed? (y) ')
    ingress.drainAndClose()
  })

  it('swallows an OSC reply echo under every POSIX shape', () => {
    for (const echoOf of [caretEcho, readlineEcho, (reply: string) => reply]) {
      const { ingress, writes, emissions } = harness()
      expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
      expect(writes).toEqual([OSC_COLOR_REPLY])
      ingress.accept(echoOf(OSC_COLOR_REPLY))
      expect(visible(emissions), echoOf(OSC_COLOR_REPLY)).toBe('')
      ingress.drainAndClose()
    }
  })

  it('never holds a partial verbatim echo, so a torn query is still answered', () => {
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      // Query authority open, so a query that survives the read boundary gets answered.
      intent: { colors: { foreground: '#2e3434', background: '#ffffff' }, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => void writes.push(data),
      onEmission: (emission) => void emissions.push(emission)
    })
    expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
    writes.length = 0

    // The verbatim shape starts with ESC, so any read ending on a bare ESC is a strict
    // prefix of it. Holding that would take the ESC from the query parser and an expired
    // hold would release it raw — the query would never be answered. Complete-match-only
    // is what makes the shape safe to project at all.
    ingress.accept('output so far\x1b')
    ingress.accept(']11;?\x07')
    // Answered: the ESC reached the query parser. Were the verbatim shape prefix-held as
    // an echo candidate, that ESC would have been taken and the query lost.
    expect(writes).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
    // And the query itself is suppressed from the visible stream, not echoed to the user.
    expect(visible(emissions)).toBe('output so far')
    ingress.drainAndClose()
  })

  it('leaves ordinary keystrokes alone', () => {
    for (const keystroke of ['y', 'gh auth login\r', '\x1b[A', '\x1b', '\x03']) {
      expect(needsCookedEchoSafeQueryReply(keystroke)).toBe(false)
    }
    const { ingress, writes } = harness()
    expect(ingress.answerLiveQueryReply('ls\r')).toBe(false)
    expect(writes).toEqual([])
    ingress.drainAndClose()
  })

  it('swallows a pre-coalesced repeated ?997 payload', () => {
    const doubled = COLOR_SCHEME_REPLY + COLOR_SCHEME_REPLY
    expect(extractOnlyCookedEchoSafeQueryReplies(doubled)).toEqual([
      COLOR_SCHEME_REPLY,
      COLOR_SCHEME_REPLY
    ])
    const { ingress, writes } = harness()
    expect(ingress.answerLiveQueryReply(doubled)).toBe(true)
    expect(writes).toEqual([COLOR_SCHEME_REPLY, COLOR_SCHEME_REPLY])
    ingress.drainAndClose()
  })

  it('leaves latency-critical replies on the host path, in call order', () => {
    const { ingress, writes } = harness()
    // CPR and DA1 need no echo containment, so the delivery declines them and the host
    // writes them itself — which is what keeps them behind the daemon's post-ready flush
    // gate instead of splicing into a buffered startup command.
    for (const reply of [CPR_REPLY, DA1_REPLY, OSC_COLOR_REPLY + DA1_REPLY]) {
      expect(ingress.answerLiveQueryReply(reply)).toBe(false)
    }
    expect(writes).toEqual([])
    ingress.drainAndClose()
  })

  it('bounds unmatched echo projections instead of shadowing the session', () => {
    const { ingress, writes, emissions } = harness()
    for (let index = 0; index < 200; index += 1) {
      ingress.answerLiveQueryReply(`\x1b]11;rgb:${String(index).padStart(2, '0')}\x07`)
    }
    expect(writes).toHaveLength(200)
    // A projection that never lands must age out, or it keeps deleting matching spans
    // out of ordinary output forever.
    ingress.accept('x'.repeat(300_000))
    ingress.accept(caretEcho('\x1b]11;rgb:00\x07'))
    expect(visible(emissions)).toContain(caretEcho('\x1b]11;rgb:00\x07'))
    ingress.drainAndClose()
  })
  // The self-heal for the one case an immediate write cannot serve: a program that
  // queries while cooked and then arms raw mode with TCSAFLUSH discards the reply along
  // with the rest of its input queue. Measured on a real pty; TCSANOW/TCSADRAIN (libuv,
  // so every Node agent) keep it. Such a program re-queries after its own timeout, and
  // the re-query must NOT be swallowed as already-answered — it is passed downstream so
  // the renderer's emulator answers it, by which point the program is raw.
  it('passes a duplicate query downstream instead of swallowing it', () => {
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: { foreground: '#2e3434', background: '#ffffff' }, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => void writes.push(data),
      onEmission: (emission) => void emissions.push(emission)
    })

    ingress.accept('\x1b]11;?\x07')
    expect(writes).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
    // Answered here, so the query itself is consumed and never rendered.
    expect(visible(emissions)).toBe('')

    ingress.accept('\x1b]11;?\x07')
    // Not answered twice — a duplicate reply corrupts a parser already mid-read — but
    // forwarded verbatim, so the downstream emulator can answer the retry.
    expect(writes).toHaveLength(1)
    expect(visible(emissions)).toBe('\x1b]11;?\x07')
    ingress.drainAndClose()
  })
})
