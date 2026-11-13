import { expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({
  environment: { id: 'env', createdAt: 1, runtimeId: 'runtime' },
  client: { connectionEpoch: 1, runtimeId: 'runtime', call: vi.fn(), subscribe: vi.fn() }
}))
vi.mock('./web-runtime-session', async () => {
  const { RuntimeRpcCallQueuePool } = await import('../../../../shared/runtime-rpc-call-queue')
  return {
    closeActiveRuntimeClients: vi.fn(),
    subscribeWebRuntimeStatus: vi.fn(),
    readWebRuntimeStatusSnapshots: vi.fn(),
    disconnectActiveRuntimeEnvironment: vi.fn(),
    getClientForEnvironment: () => session.client,
    manuallyDisconnectedEnvironmentIds: new Set<string>(),
    removeActiveRuntimeEnvironment: vi.fn(),
    requireActiveEnvironment: () => session.environment,
    requireActiveEnvironmentOrNull: () => session.environment,
    resolveEnvironment: () => session.environment,
    webRuntimeState: { activeEnvironment: session.environment },
    runtimeCallQueuePool: new RuntimeRpcCallQueuePool(),
    updateEnvironmentFromResponse: vi.fn(),
    manuallyDisconnectedResponse: vi.fn()
  }
})
import { createRuntimeEnvironmentsApi } from './web-runtime-environments-api'

it('holds web signal-route slots through responses and releases queued and active cancellations', async () => {
  const responseOrder: string[] = []
  const finish: (() => void)[] = []
  const closed = vi.fn()
  session.client.subscribe.mockImplementation(async (_method, _params, callbacks) => {
    finish.push(() =>
      callbacks.onResponse({ id: 'rpc', ok: true, result: {}, _meta: { runtimeId: 'runtime' } })
    )
    return {
      unsubscribe: () => {
        closed()
        responseOrder.push('close')
        callbacks.onClose?.()
      },
      sendBinary: vi.fn()
    }
  })
  const api = createRuntimeEnvironmentsApi()
  const start = (subscriptionId: string, reason: string, method = 'github.prForBranch') =>
    api.subscribe(
      { selector: 'env', subscriptionId, method, params: { reason }, timeoutMs: 30_000 },
      { onResponse: () => responseOrder.push('response') }
    )
  const first = await start('timer-1', 'swr')
  const second = await start('timer-2', 'swr')
  const third = start('timer-3', 'swr')
  const cancelled = expect(third).rejects.toThrow()
  const manual = await start('manual', 'manual')
  const status = await start('status', '', 'git.status')
  const review = await start('review', '', 'hostedReview.forBranch')
  expect(finish).toHaveLength(5)
  await api.cancelSubscription({ subscriptionId: 'timer-3' })
  await cancelled
  const fourth = start('timer-4', 'swr')
  finish[0]()
  const fourthHandle = await fourth
  expect(finish).toHaveLength(6)
  expect(responseOrder.slice(0, 2)).toEqual(['response', 'close'])
  const fifth = start('timer-5', 'swr')
  second.unsubscribe()
  const fifthHandle = await fifth
  expect(finish).toHaveLength(7)
  first.unsubscribe()
  fourthHandle.unsubscribe()
  fifthHandle.unsubscribe()
  manual.unsubscribe()
  status.unsubscribe()
  review.unsubscribe()
  await Promise.resolve()
  expect(closed).toHaveBeenCalledTimes(7)
})
