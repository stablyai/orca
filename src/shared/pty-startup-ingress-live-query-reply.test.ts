// #13137: live color replies need startup's cooked-echo containment.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyStartupIngress, type PtyIngressEmission } from './pty-startup-ingress'
import type {
  PtySlaveEchoProbe,
  PtySlaveLineDisciplineEcho
} from './pty-slave-line-discipline-echo'
import { mode2031SequenceFor } from './terminal-color-scheme-protocol'
import {
  extractOnlyCookedEchoSafeQueryReplies,
  needsCookedEchoSafeQueryReply
} from './terminal-query-reply'

const COLOR_SCHEME_REPLY = mode2031SequenceFor('dark')
// CSI has only a caret echo; OSC also has readline's rewritten echo.
const POSIX_CSI_COOKED_ECHO = (reply: string): string => reply.replaceAll('\x1b', '^[')
const OSC_COLOR_REPLY = '\x1b]11;rgb:00/00/00\x07'
const POSIX_OSC_COOKED_ECHOES = [
  (reply: string): string => reply.replaceAll('\x1b', '^['),
  (reply: string): string => reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')
]

function scriptedEchoProbe(...states: PtySlaveLineDisciplineEcho[]) {
  let index = 0
  const probe: PtySlaveEchoProbe & { calls: number } = Object.assign(
    async () => {
      probe.calls += 1
      return states[Math.min(index++, states.length - 1)] ?? 'unknown'
    },
    { calls: 0 }
  )
  return probe
}

function visible(emissions: readonly PtyIngressEmission[]): string {
  return emissions.map((emission) => emission.data).join('')
}

afterEach(() => vi.useRealTimers())

describe('PtyStartupIngress live query replies (#13137)', () => {
  it('classifies the real mode-2031 reply as cooked-echo-risk', () => {
    expect(COLOR_SCHEME_REPLY).toBe('\x1b[?997;1n')
    expect(needsCookedEchoSafeQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    expect(needsCookedEchoSafeQueryReply(mode2031SequenceFor('light'))).toBe(true)
  })

  it('swallows a live color-scheme DSR caret echo after query authority closes', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    let ingress: PtyStartupIngress | undefined
    ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      write: (data) => {
        writes.push(data)
        ingress?.accept(POSIX_CSI_COOKED_ECHO(data))
      },
      onEmission: (emission) => emissions.push(emission)
    })

    expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    vi.advanceTimersByTime(0)
    expect(writes).toEqual([COLOR_SCHEME_REPLY])
    expect(visible(emissions)).toBe('')
    expect(visible(emissions)).not.toContain('997;1n')
    expect(visible(emissions)).not.toContain(COLOR_SCHEME_REPLY)

    ingress.accept('Ok to proceed? (y) ')
    expect(visible(emissions)).toBe('Ok to proceed? (y) ')
    expect(visible(emissions)).not.toContain('997')
    expect(writes).toEqual([COLOR_SCHEME_REPLY])
    ingress.drainAndClose()
  })

  it('gives a reply answered after the startup window the tight post-deadline budget', () => {
    // Why: at the startup budget the projection stays armed for 256 KB, so any later literal
    // `^[[?997;1n` in ordinary output — a captured session log, `cat -v` — is silently deleted,
    // and on an idle pane those bytes are never spent so it never disarms.
    vi.useFakeTimers()
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      intent: { colors: { foreground: '#000000', background: '#ffffff' }, deadlineMs: 10 },
      write: () => {},
      onEmission: (emission) => emissions.push(emission)
    })

    // Close the startup window, then answer a query the way a mid-session program would.
    vi.advanceTimersByTime(11)
    expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    vi.advanceTimersByTime(0)

    ingress.accept('x'.repeat(1024))
    emissions.length = 0

    // The projection has expired, so output that merely looks like the echo survives.
    const literal = POSIX_CSI_COOKED_ECHO(COLOR_SCHEME_REPLY)
    ingress.accept(literal)
    vi.advanceTimersByTime(600)
    expect(visible(emissions)).toContain(literal)
    ingress.drainAndClose()
  })

  it('swallows OSC color reply echoes under both POSIX projections', () => {
    vi.useFakeTimers()
    for (const echoOf of POSIX_OSC_COOKED_ECHOES) {
      const writes: string[] = []
      const emissions: PtyIngressEmission[] = []
      let ingress: PtyStartupIngress | undefined
      ingress = new PtyStartupIngress({
        ownerBackend: 'posix-pty',
        write: (data) => {
          writes.push(data)
          ingress?.accept(echoOf(data))
        },
        onEmission: (emission) => emissions.push(emission)
      })

      expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
      vi.advanceTimersByTime(0)
      expect(writes).toEqual([OSC_COLOR_REPLY])
      expect(visible(emissions)).toBe('')
      ingress.drainAndClose()
    }
  })

  it('defers a live query reply while the slave is still echoing', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const probe = scriptedEchoProbe('echoing', 'echoing', 'quiet')
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      echoProbe: probe,
      write: (data) => writes.push(data),
      onEmission: () => {}
    })

    expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    expect(writes).toEqual([COLOR_SCHEME_REPLY])
    expect(probe.calls).toBe(3)
    await vi.advanceTimersByTimeAsync(200)
    expect(writes).toEqual([COLOR_SCHEME_REPLY])
    ingress.drainAndClose()
  })

  it('writes within the echo budget when a probe never settles', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const echoProbe: PtySlaveEchoProbe = () => new Promise(() => {})
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      echoProbe,
      write: (data) => writes.push(data),
      onEmission: () => {}
    })

    expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(199)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(writes).toEqual([COLOR_SCHEME_REPLY])
    ingress.drainAndClose()
  })

  it('caps probe subprocess starts across live reply bursts', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const probe = scriptedEchoProbe('echoing')
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      echoProbe: probe,
      write: (data) => writes.push(data),
      onEmission: () => {}
    })

    expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(probe.calls).toBe(10)
    expect(writes).toEqual([COLOR_SCHEME_REPLY])

    expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(probe.calls).toBe(10)
    expect(writes).toEqual([COLOR_SCHEME_REPLY, COLOR_SCHEME_REPLY])
    ingress.drainAndClose()
  })

  it('keeps a keystroke behind a reply the echo probe is still holding', async () => {
    // #13137 from the other direction: a reply overtaken by input lands in the NEXT reader's
    // stdin, self-inserting `[?997;1n` once the prompt it answered is already gone.
    vi.useFakeTimers()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const probe = scriptedEchoProbe('echoing')
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      echoProbe: probe,
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    // Every host write path in one shape: reply-or-flush, then raw.
    const hostWrite = (data: string): void => {
      if (extractOnlyCookedEchoSafeQueryReplies(data) && ingress.answerLiveQueryReply(data)) {
        return
      }
      ingress.flushDeferredQueryReplies()
      writes.push(data)
    }

    hostWrite(COLOR_SCHEME_REPLY)
    await vi.advanceTimersByTimeAsync(20)
    expect(writes).toEqual([])

    // The user answers the npx confirm prompt while the reply is still withheld.
    hostWrite('y\r')
    expect(writes).toEqual([COLOR_SCHEME_REPLY, 'y\r'])

    // The forced write keeps its echo suppressed — only the probe's verdict was given up.
    ingress.accept(POSIX_CSI_COOKED_ECHO(COLOR_SCHEME_REPLY))
    await vi.advanceTimersByTimeAsync(600)
    expect(visible(emissions)).toBe('')
    expect(writes).toEqual([COLOR_SCHEME_REPLY, 'y\r'])
    ingress.drainAndClose()
  })

  it('does not route ordinary keystrokes through the echo-safe reply path', () => {
    expect(needsCookedEchoSafeQueryReply('y')).toBe(false)
    expect(needsCookedEchoSafeQueryReply('yes\r')).toBe(false)
    expect(needsCookedEchoSafeQueryReply('\x1b[A')).toBe(false)
    expect(needsCookedEchoSafeQueryReply('\x1b[3;1R')).toBe(false)
  })

  it('swallows a pre-coalesced repeated ?997 payload on the host write path', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    let ingress: PtyStartupIngress | undefined
    ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      write: (data) => {
        writes.push(data)
        ingress?.accept(POSIX_CSI_COOKED_ECHO(data))
      },
      onEmission: (emission) => emissions.push(emission)
    })

    const coalesced = COLOR_SCHEME_REPLY + COLOR_SCHEME_REPLY
    expect(needsCookedEchoSafeQueryReply(coalesced)).toBe(false)
    expect(extractOnlyCookedEchoSafeQueryReplies(coalesced)).toEqual([
      COLOR_SCHEME_REPLY,
      COLOR_SCHEME_REPLY
    ])
    expect(ingress.answerLiveQueryReply(coalesced)).toBe(true)
    vi.advanceTimersByTime(0)
    expect(writes).toEqual([COLOR_SCHEME_REPLY, COLOR_SCHEME_REPLY])
    expect(visible(emissions)).toBe('')
    expect(visible(emissions)).not.toContain('997')
    ingress.drainAndClose()
  })

  it('preserves identical replies after a quiet CSI write', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const probe = scriptedEchoProbe('quiet')
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      echoProbe: probe,
      write: (data) => writes.push(data),
      onEmission: () => {}
    })

    expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([COLOR_SCHEME_REPLY])

    expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([COLOR_SCHEME_REPLY, COLOR_SCHEME_REPLY])
    ingress.drainAndClose()
  })

  it('bounds pending writes and unmatched live echo projections', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    const replies = Array.from(
      { length: 65 },
      (_, index) => `\x1b]10;rgb:${index.toString().padStart(2, '0')}\x07`
    )

    for (const reply of replies) {
      expect(ingress.answerLiveQueryReply(reply)).toBe(true)
    }
    // The 65th enqueue forces the bounded pending set to flush without dropping data.
    expect(writes).toHaveLength(64)
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual(replies)

    const firstReply = replies[0]
    const lastReply = replies.at(-1)
    if (!firstReply || !lastReply) {
      throw new Error('expected bounded reply fixture')
    }
    ingress.accept(POSIX_CSI_COOKED_ECHO(firstReply))
    ingress.accept(POSIX_CSI_COOKED_ECHO(lastReply))
    expect(visible(emissions)).toContain('rgb:00')
    expect(visible(emissions)).not.toContain('rgb:64')
    ingress.drainAndClose()
  })
})
