import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => {
  const client = {
    connectionEpoch: 1,
    runtimeId: 'runtime-a',
    call: vi.fn()
  }
  return { client, environment: { id: 'env-1', createdAt: 1 } }
})

vi.mock('./web-runtime-session', () => ({
  getClientForEnvironment: () => session.client,
  manuallyDisconnectedEnvironmentIds: new Set<string>(),
  manuallyDisconnectedResponse: () => ({ ok: false }),
  requireActiveEnvironment: () => session.environment,
  resolveEnvironment: () => session.environment,
  runtimeCallQueuePool: { enqueue: (_id: string, _method: string, run: () => unknown) => run() },
  updateEnvironmentFromResponse: () => undefined
}))

import { callEnvironmentEnvelope } from './web-runtime-calls'
import { RUNTIME_CONNECTION_CHANGED_MESSAGE } from '../web-runtime-request-registry'

describe('web runtime call pinned to the probed runtime', () => {
  beforeEach(() => {
    session.client.connectionEpoch = 1
    session.client.runtimeId = 'runtime-a'
    session.client.call.mockReset()
    session.client.call.mockImplementation(async () => ({
      id: 'rpc',
      ok: true,
      result: {},
      _meta: { runtimeId: session.client.runtimeId }
    }))
  })

  it('sends a runtime-pinned write only on the connection where that runtime answered', async () => {
    await callEnvironmentEnvelope('env-1', 'status.get')
    // The same client reconnects to an older server before the write is sent.
    session.client.connectionEpoch = 2
    session.client.runtimeId = 'runtime-b'

    await callEnvironmentEnvelope('env-1', 'files.write', {}, 15_000, undefined, 'runtime-a')

    expect(session.client.call).toHaveBeenLastCalledWith(
      'files.write',
      {},
      {
        timeoutMs: 15_000,
        expectedConnectionEpoch: 1
      }
    )
  })

  it('refuses a runtime-pinned write that no probe on this client vouches for', async () => {
    await expect(
      callEnvironmentEnvelope('env-1', 'files.write', {}, 15_000, undefined, 'runtime-never-probed')
    ).rejects.toThrow(RUNTIME_CONNECTION_CHANGED_MESSAGE)
    expect(session.client.call).not.toHaveBeenCalled()
  })
})
