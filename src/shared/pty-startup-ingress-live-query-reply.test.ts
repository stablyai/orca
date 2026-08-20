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
// Latency-critical, so it stays off the contained path — but must not overtake one.
const CPR_REPLY = '\x1b[6;1R'
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

  // termenv writes `OSC 11 ;? ST` then `CSI 6n` and stops reading at the CPR, so a
  // CPR that overtakes the still-deferred color reply strands it for the next program
  // (`gh auth login` -> "unexpected escape sequence from terminal: ['\x1b' ']']").
  it('holds a CPR reply behind a still-deferred color reply', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const probe = scriptedEchoProbe('echoing', 'quiet')
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      echoProbe: probe,
      write: (data) => writes.push(data),
      onEmission: () => {}
    })

    expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([])
    expect(ingress.writeQueryReplyInOrder(CPR_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(20)
    expect(writes).toEqual([OSC_COLOR_REPLY, CPR_REPLY])
    ingress.drainAndClose()
  })

  it('leaves a CPR reply on the caller immediate path when nothing is deferred', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      echoProbe: scriptedEchoProbe('quiet'),
      write: (data) => writes.push(data),
      onEmission: () => {}
    })

    expect(ingress.writeQueryReplyInOrder(CPR_REPLY)).toBe(false)
    expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([OSC_COLOR_REPLY])
    expect(ingress.writeQueryReplyInOrder(CPR_REPLY)).toBe(false)
    ingress.drainAndClose()
  })

  it('does not project an ordered CPR reply as an echo to swallow', async () => {
    vi.useFakeTimers()
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      // Never settles, so the budget-expiry flush runs with kernelEchoImpossible
      // false — the only verdict under which the caret shape IS armed, so this is
      // what discriminates the uncontained branch from the contained one.
      echoProbe: () => new Promise(() => {}),
      write: () => {},
      onEmission: (emission) => emissions.push(emission)
    })

    expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(ingress.writeQueryReplyInOrder(CPR_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    // The CPR rode the queue for order only, so its caret shape is ordinary output.
    ingress.accept(POSIX_CSI_COOKED_ECHO(CPR_REPLY))
    expect(visible(emissions)).toBe(POSIX_CSI_COOKED_ECHO(CPR_REPLY))
    ingress.drainAndClose()
  })

  // An ordered reply must not restart the ECHO probe: attemptPendingWrites nulls
  // writeTimer on entry, so re-arming forks a second stty and discards the in-flight
  // verdict, delaying the contained reply this queue exists to deliver first.
  it('queues ordered replies without spawning extra echo probes', async () => {
    vi.useFakeTimers()
    const counts: number[] = []
    for (const orderedCount of [0, 8]) {
      const writes: string[] = []
      let calls = 0
      // Never settles, so the probe stays in flight across the whole queueing window.
      const probe = (): Promise<never> => {
        calls += 1
        return new Promise(() => {})
      }
      const ingress = new PtyStartupIngress({
        ownerBackend: 'posix-pty',
        echoProbe: probe,
        write: (data) => writes.push(data),
        onEmission: () => {}
      })

      expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      for (let i = 0; i < orderedCount; i += 1) {
        ingress.writeQueryReplyInOrder(CPR_REPLY)
      }
      await vi.advanceTimersByTimeAsync(200)
      expect(writes[0]).toBe(OSC_COLOR_REPLY)
      expect(writes).toHaveLength(1 + orderedCount)
      counts.push(calls)
      ingress.drainAndClose()
    }
    expect(counts).toEqual([1, 1])
  })

  it('keeps holding a contained reply to its budget while the probe reports echoing', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const probe = scriptedEchoProbe('echoing')
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      echoProbe: probe,
      write: (data) => writes.push(data),
      onEmission: () => {}
    })

    expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 8; i += 1) {
      ingress.writeQueryReplyInOrder(CPR_REPLY)
    }
    // A burst of ordered replies must not exhaust the probe-start budget and force an
    // early unprobed flush, which would paint the reply onto a still-cooked prompt.
    await vi.advanceTimersByTimeAsync(199)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(2)
    expect(writes[0]).toBe(OSC_COLOR_REPLY)
    ingress.drainAndClose()
  })

  it('hands a queued ordered reply to the pty at teardown instead of dropping it', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      echoProbe: () => new Promise(() => {}),
      write: (data) => writes.push(data),
      onEmission: () => {}
    })

    expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(ingress.writeQueryReplyInOrder(CPR_REPLY)).toBe(true)
    // Daemon dispose drains before the kill, so the child can still be blocked on this.
    ingress.drainAndClose()
    expect(writes).toEqual([CPR_REPLY])
  })

  it('never takes the ordered path on backends that do not defer', async () => {
    vi.useFakeTimers()
    for (const ownerBackend of ['windows-conpty', 'windows-wsl'] as const) {
      const writes: string[] = []
      const ingress = new PtyStartupIngress({
        ownerBackend,
        write: (data) => writes.push(data),
        onEmission: () => {}
      })
      expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
      expect(ingress.writeQueryReplyInOrder(CPR_REPLY)).toBe(false)
      expect(writes).toEqual([OSC_COLOR_REPLY])
      ingress.drainAndClose()
    }
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
