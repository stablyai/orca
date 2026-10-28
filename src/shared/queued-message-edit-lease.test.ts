import { beforeAll, afterEach, expect, it, vi } from 'vitest'
import { startQueuedEditLease, QUEUED_EDIT_LEASE_RENEW_MS } from './queued-message-edit-lease'
import type { QueuedEditHostFixtureModule } from './queued-edit-host.test-fixture'
import type {
  AgentSessionQueuedMessageEditHoldParams,
  AgentSessionQueuedMessageEditHoldResult
} from './agent-session-wire'

let queuedEditHost: QueuedEditHostFixtureModule['queuedEditHost']
beforeAll(async () => {
  const fixtures = await vi.importActual<QueuedEditHostFixtureModule>(
    '../main/native-chat/agent-session-journal/queued-edit-host.test-fixture'
  )
  queuedEditHost = fixtures.queuedEditHost
})

const message = {
  messageId: 'card',
  position: 1,
  state: 'waiting' as const,
  body: {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'A' }]
  }
}
afterEach(() => vi.useRealTimers())

it.each(['initial', 'renew', 'reacquire'] as const)(
  'end during pending %s suppresses delivery and releases exactly after owned work',
  async (phase) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const host = queuedEditHost('session', message)
    const onLost = vi.fn()
    const events: string[] = []
    let finish!: () => void
    let count = 0
    const request = vi.fn(
      async (
        params: AgentSessionQueuedMessageEditHoldParams
      ): Promise<AgentSessionQueuedMessageEditHoldResult> => {
        events.push(`start:${params.action}`)
        const key = { callerKey: 'client', editId: params.editId }
        if (params.action === 'release') {
          host.leases.release(key, params.messageId)
          events.push('end:release')
          return { status: 'released' }
        }
        count++
        if (count === (phase === 'initial' ? 1 : phase === 'renew' ? 2 : 3)) {
          await new Promise<void>((resolve) => {
            finish = resolve
          })
        }
        const answer =
          params.action === 'acquire'
            ? host.acquire(params.editId, params.expectedBodyFingerprint ?? '')
            : host.leases.renew(key, params.messageId)
        events.push(`end:${params.action}:${answer.status}`)
        return answer
      }
    )
    const lease = startQueuedEditLease({
      sessionId: 'session',
      messageId: 'card',
      editId: 'edit',
      expectedBodyFingerprint: host.row!.fingerprint,
      request,
      onLost
    })
    if (phase !== 'initial') {
      await lease.acquired
      if (phase === 'reacquire') {
        host.leases.retire('card')
      }
      await vi.advanceTimersByTimeAsync(QUEUED_EDIT_LEASE_RENEW_MS)
    }
    expect(finish).toBeTypeOf('function')
    lease.end()
    lease.end()
    expect(events.at(-1)).toBe(`start:${phase === 'renew' ? 'renew' : 'acquire'}`)
    expect(request.mock.calls.some(([params]) => params.action === 'release')).toBe(false)
    host.depart()
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.slice(-2)).toEqual(['start:release', 'end:release'])
    expect(onLost).not.toHaveBeenCalled()
    expect(request.mock.calls.filter(([params]) => params.action === 'release')).toHaveLength(1)
    expect(request.mock.calls.at(-1)?.[0]).toEqual({
      sessionId: 'session',
      messageId: 'card',
      editId: 'edit',
      action: 'release'
    })
    const calls = request.mock.calls.length
    await vi.advanceTimersByTimeAsync(4 * QUEUED_EDIT_LEASE_RENEW_MS)
    expect(request).toHaveBeenCalledTimes(calls)
    host.leases.dispose()
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('keeps the existing held/failure/expired-to-held request protocol without terminal delivery', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const host = queuedEditHost('session', message)
  const onLost = vi.fn()
  let fail = true
  const request = vi.fn(
    async (
      params: AgentSessionQueuedMessageEditHoldParams
    ): Promise<AgentSessionQueuedMessageEditHoldResult> => {
      if (params.action === 'release') {
        return { status: 'released' }
      }
      if (params.action === 'renew' && fail) {
        fail = false
        throw new Error('offline')
      }
      return params.action === 'acquire'
        ? host.acquire(params.editId, params.expectedBodyFingerprint ?? '')
        : host.leases.renew({ callerKey: 'client', editId: params.editId }, params.messageId)
    }
  )
  const lease = startQueuedEditLease({
    sessionId: 'session',
    messageId: 'card',
    editId: 'edit',
    expectedBodyFingerprint: host.row!.fingerprint,
    request,
    onLost
  })
  await lease.acquired
  await vi.advanceTimersByTimeAsync(QUEUED_EDIT_LEASE_RENEW_MS)
  host.leases.retire('card')
  await vi.advanceTimersByTimeAsync(QUEUED_EDIT_LEASE_RENEW_MS)
  expect(request.mock.calls.map(([params]) => params.action)).toEqual([
    'acquire',
    'renew',
    'renew',
    'acquire'
  ])
  expect(host.leases.heldIds()).toEqual(new Set(['card']))
  expect(onLost).not.toHaveBeenCalled()
  lease.end()
  await vi.advanceTimersByTimeAsync(0)
  host.leases.dispose()
  expect(vi.getTimerCount()).toBe(0)
  warn.mockRestore()
})

it.each([10, 100])(
  'terminal completion for %i independent leases delivers once per owner with no followup requests',
  async (n) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onLost = vi.fn()
    const request = vi.fn(
      async (
        params: AgentSessionQueuedMessageEditHoldParams
      ): Promise<AgentSessionQueuedMessageEditHoldResult> =>
        params.action === 'release' ? { status: 'released' } : { status: 'gone' }
    )
    const leases = Array.from({ length: n }, (_, index) =>
      startQueuedEditLease({
        sessionId: `session-${index}`,
        messageId: 'card',
        editId: `edit-${index}`,
        expectedBodyFingerprint: `base-${index}`,
        request,
        onLost
      })
    )
    await Promise.all(leases.map((lease) => lease.acquired))
    expect(onLost).toHaveBeenCalledTimes(n)
    leases.forEach((lease, index) =>
      expect(onLost.mock.calls[index]?.[0]).toEqual({
        lease,
        expected: `base-${index}`,
        status: 'gone'
      })
    )
    expect(request).toHaveBeenCalledTimes(n)
    leases.forEach((lease) => lease.end())
    await vi.advanceTimersByTimeAsync(4 * QUEUED_EDIT_LEASE_RENEW_MS)
    expect(onLost).toHaveBeenCalledTimes(n)
    expect(request).toHaveBeenCalledTimes(2 * n)
    expect(vi.getTimerCount()).toBe(0)
  }
)
