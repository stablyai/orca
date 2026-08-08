// #13137: live xterm query replies (color-scheme 997) must use the same
// ECHO-safe delivery as startup color replies so cooked prompts stay clean.
import { describe, expect, it, vi } from 'vitest'
import { PtyStartupIngress, type PtyIngressEmission } from './pty-startup-ingress'
import type {
  PtySlaveEchoProbe,
  PtySlaveLineDisciplineEcho
} from './pty-slave-line-discipline-echo'

const COLOR_SCHEME_REPLY = '\x1b[?997;1n'
const POSIX_COOKED_ECHOES = [
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

describe('PtyStartupIngress live query replies (#13137)', () => {
  it('swallows a live color-scheme DSR reply echo after query authority closes', () => {
    vi.useFakeTimers()
    for (const echoOf of POSIX_COOKED_ECHOES) {
      const writes: string[] = []
      const emissions: PtyIngressEmission[] = []
      let ingress!: PtyStartupIngress
      ingress = new PtyStartupIngress({
        ownerBackend: 'posix-pty',
        write: (data) => {
          writes.push(data)
          ingress.accept(echoOf(data))
        },
        onEmission: (emission) => emissions.push(emission)
      })

      expect(ingress.answerLiveQueryReply(COLOR_SCHEME_REPLY)).toBe(true)
      vi.advanceTimersByTime(0)
      expect(writes).toEqual([COLOR_SCHEME_REPLY])
      expect(visible(emissions)).toBe('')

      ingress.accept('Ok to proceed? (y) ')
      expect(visible(emissions)).toBe('Ok to proceed? (y) ')
      ingress.drainAndClose()
    }
    vi.useRealTimers()
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
    ingress.drainAndClose()
  })
})
