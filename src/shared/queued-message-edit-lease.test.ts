import { beforeAll, afterEach, expect, it, vi } from 'vitest'
import { startQueuedEditLease, QUEUED_EDIT_LEASE_RENEW_MS } from './queued-message-edit-lease'
import type { QueuedEditHostFixtureModule } from './queued-edit-host.test-fixture'
import type {
  AgentSessionQueuedMessageEditHoldParams,
  AgentSessionQueuedMessageEditHoldResult
} from './agent-session/requests/agent-session-queued-message-wire'

let queuedEditHost: QueuedEditHostFixtureModule['queuedEditHost']
beforeAll(async () => {
  const fixtures = await vi.importActual<QueuedEditHostFixtureModule>(
    '../main/native-chat/agent-session-journal/queued-messages/queued-edit-host.test-fixture'
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
  warn.mockRestore()
})
