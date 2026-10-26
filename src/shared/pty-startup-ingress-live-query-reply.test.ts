// Write live replies synchronously in call order; deferral let replies overtake and enter later programs’ stdin (#15559).
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
// ECHOCTL encodes every C0 including BEL→^G; live PTY transcripts disprove the old ESC-only fixture.
const caretEcho = (reply: string): string =>
  [...reply]
    .map((ch) =>
      ch.charCodeAt(0) < 0x20 ? `^${String.fromCharCode(ch.charCodeAt(0) + 0x40)}` : ch
    )
    .join('')
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

    // ESC-led verbatim echoes match only complete spans: holding a bare ESC would steal a torn query from its parser.
    ingress.accept('output so far\x1b')
    ingress.accept(']11;?\x07')
    expect(writes).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
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
    // Host writes CPR/DA1 behind daemon post-ready flush; delivery declines them instead of splicing replies into buffered startup commands.
    for (const reply of [CPR_REPLY, DA1_REPLY, OSC_COLOR_REPLY + DA1_REPLY]) {
      expect(ingress.answerLiveQueryReply(reply)).toBe(false)
    }
    expect(writes).toEqual([])
    ingress.drainAndClose()
  })

  // The seven-byte private-DSR readline needle may remove one exact armed match, never filter ordinary output indefinitely.
  describe('the short readline needle does not eat ordinary output', () => {
    const armed = (chunks: readonly string[]): string => {
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        ownerBackend: 'posix-pty',
        write: () => {},
        onEmission: (emission) => void emissions.push(emission)
      })
      ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)
      for (const chunk of chunks) {
        ingress.accept(chunk)
      }
      ingress.drainAndClose()
      return visible(emissions)
    }

    it.each([
      { name: 'BEL then a bare number', text: '\x07997 files changed\n' },
      { name: 'BEL then a near-miss final byte', text: '\x07997;1m not a reply\n' },
      { name: 'the digits without the BEL', text: '  45% ==== 997;1n bytes\n' },
      { name: 'a bell mid-word', text: 'ding\x07 done\n' },
      { name: 'ls colour output', text: '\x1b[01;34msrc\x1b[0m  \x1b[01;32mrun.sh\x1b[0m\n' },
      { name: 'a stack trace carrying 997:1', text: 'Error: boom\n    at f (/a/b.js:997:1)\n' }
    ])('passes $name through untouched', ({ text }) => {
      expect(armed([text])).toBe(text)
      // Same, torn at every byte boundary: a partial hold must still release intact.
      for (let split = 1; split < text.length; split += 1) {
        expect(armed([text.slice(0, split), text.slice(split)])).toBe(text)
      }
    })

    it('suppresses the echo once, then stops', () => {
      const echo = '\x07997;1n'
      expect(armed([echo])).toBe('')
      // One reply written, one span consumed — a repeat is ordinary output.
      expect(armed([echo, echo])).toBe(echo)
    })

    it('suppresses nothing when no reply was written', () => {
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        ownerBackend: 'posix-pty',
        write: () => {},
        onEmission: (emission) => void emissions.push(emission)
      })
      ingress.accept('\x07997;1n')
      ingress.drainAndClose()
      expect(visible(emissions)).toBe('\x07997;1n')
    })
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
  // Cooked programs switching raw with TCSAFLUSH discard queued replies (measured on real PTY); TCSANOW/TCSADRAIN retain them.
  // Answer retries too so such programs recover after their own timeout, once raw.
  it('answers a re-query itself instead of treating it as already answered', () => {
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
    ingress.accept('\x1b]11;?\x07')
    // One reply per query, and neither query reaches a view that could answer it again.
    expect(writes).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
    expect(visible(emissions)).toBe('')
    ingress.drainAndClose()
  })
})
