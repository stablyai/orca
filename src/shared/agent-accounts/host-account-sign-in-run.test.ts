import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostAccountSignInRun, type HostAccountSignInTransport } from './host-account-sign-in-run'
import type { HostAccountSignInStatus } from './host-account-sign-in-types'

class Lost extends Error {}

const prompt = {
  url: 'https://auth.openai.com/codex/device',
  userCode: 'K7QX-9PLM',
  needsCode: false
}
const status = (revision: number, phase: HostAccountSignInStatus['phase']) => ({
  flowId: 'flow-1',
  provider: 'codex' as const,
  revision,
  phase,
  ...(phase === 'waiting' ? { prompt } : {})
})

describe('HostAccountSignInRun', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps following the same flow through lost answers while the person is away on the page', async () => {
    const calls: string[] = []
    let lostWaits = 0
    const transport: HostAccountSignInTransport = {
      start: async () => {
        calls.push('start')
        return status(2, 'waiting')
      },
      wait: async () => {
        calls.push('wait')
        // Seven minutes on the sign-in page: every wait is lost, far past the old 80 s retry window.
        if (lostWaits < 14) {
          lostWaits += 1
          vi.setSystemTime(Date.now() + 30_000)
          throw new Lost('Request timed out')
        }
        return status(3, 'signedIn')
      },
      submitCode: async () => status(3, 'verifying'),
      cancel: async () => {
        calls.push('cancel')
        return status(3, 'cancelled')
      },
      isLostAnswer: (error) => error instanceof Lost,
      failureText: () => 'failed',
      cancelledText: 'cancelled'
    }
    const done = new HostAccountSignInRun('codex', undefined, transport, () => {}).run()
    await vi.runAllTimersAsync()
    await expect(done).resolves.toMatchObject({ phase: 'signedIn', revision: 3 })
    expect(calls.filter((call) => call !== 'wait')).toEqual(['start'])
  })

  it('stops once the host has been unreachable longer than it keeps an unattended flow', async () => {
    let waits = 0
    const transport: HostAccountSignInTransport = {
      start: async () => status(2, 'waiting'),
      wait: async () => {
        waits += 1
        vi.setSystemTime(Date.now() + 30_000)
        throw new Lost('Request timed out')
      },
      submitCode: async () => status(3, 'verifying'),
      cancel: async () => status(3, 'cancelled'),
      isLostAnswer: (error) => error instanceof Lost,
      failureText: () => 'failed',
      cancelledText: 'cancelled'
    }
    const done = new HostAccountSignInRun('codex', undefined, transport, () => {}).run()
    const settled = expect(done).rejects.toThrow('Request timed out')
    await vi.runAllTimersAsync()
    await settled
    expect(waits).toBeLessThanOrEqual(20)
  })
})
