import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../preload/api-types'
import type { CrewSubscriptionAttemptArgs } from '../../../shared/runtime-environment-subscription-setup'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'
import type * as RuntimeSession from './preload-api/web-runtime-session'
import { installBrowserGlobals } from './web-preload-api-test-harness'
import {
  CrewSocket,
  flushCrewWork,
  installCrewSocketGlobals,
  latestCrewSocket,
  publicKeyB64,
  verifyCrewPrimary
} from './web-runtime-crew.test-fixture'

const args: CrewSubscriptionAttemptArgs = {
  subscriptionId: 'crew',
  selector: 'host',
  method: 'orchestration.crewSubscribe',
  expectedEnvironmentPairingRevision: 1,
  expectedEnvironmentRuntimeId: 'rt',
  timeoutMs: 15_000
}
const legacyArgs: Parameters<PreloadApi['runtimeEnvironments']['subscribe']>[0] = {
  ...args,
  expectedEnvironmentRuntimeId: 'rt'
}
const environment: StoredWebRuntimeEnvironment = {
  id: 'host',
  name: 'Host',
  createdAt: 1,
  updatedAt: 1,
  pairingRevision: 1,
  runtimeId: 'rt',
  lastUsedAt: null,
  preferredEndpointId: 'endpoint',
  endpoints: [
    {
      id: 'endpoint',
      kind: 'websocket',
      label: 'WebSocket',
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64
    }
  ]
}

describe('opt-in browser API and actual renderer attempt boundary', () => {
  let session: typeof RuntimeSession
  let api: PreloadApi['runtimeEnvironments']
  let subscribe: NonNullable<PreloadApi['runtimeEnvironments']['subscribeCrewAttempt']>
  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    installCrewSocketGlobals()
    const globals = installBrowserGlobals()
    Object.assign(globals.window, { setTimeout, clearTimeout, setInterval, clearInterval })
    globals.storage.setItem('orca.web.runtimeEnvironment.v1', JSON.stringify(environment))
    session = await import('./preload-api/web-runtime-session')
    api = (
      await import('./preload-api/web-runtime-environments-api')
    ).createRuntimeEnvironmentsApi()
    Object.assign(globals.window, { api: { runtimeEnvironments: api } })
    if (!api.subscribeCrewAttempt) {
      throw new Error('Candidate API absent')
    }
    subscribe = api.subscribeCrewAttempt
  })
  afterEach(() => {
    session?.closeActiveRuntimeClients()
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function ready(): Promise<CrewSocket> {
    const child = latestCrewSocket()
    child.open()
    child.ready()
    await flushCrewWork()
    child.authenticated()
    await flushCrewWork()
    return child
  }

  it('keeps default rejection/observer separate and sends the SAME mapped promise to unchanged observer and consumer', async () => {
    const pairing = await import('../runtime/runtime-environment-pairing-refresh')
    const observer = vi.spyOn(pairing, 'observePairingRefusal')
    const { createRuntimeCrewSubscriptionAttempt, RuntimeCrewSetupError } =
      await import('../runtime/runtime-crew-subscribe')
    const attempt = createRuntimeCrewSubscriptionAttempt(
      {
        selector: 'host',
        params: { party: 'one' },
        expectedEnvironmentPairingRevision: 2,
        expectedEnvironmentRuntimeId: 'rt'
      },
      { onResponse: vi.fn() }
    )
    const request = attempt.start()
    expect(attempt.start()).toBe(request)
    expect(observer).toHaveBeenCalledWith(request)
    const error = await request.catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(RuntimeCrewSetupError)
    expect(error).toMatchObject({
      message: 'The paired Orca server changed while the request was in progress.',
      fact: { kind: 'source-retired' }
    })
    expect(CrewSocket.sockets).toHaveLength(0)
    await expect(
      api.subscribe(
        { ...legacyArgs, expectedEnvironmentPairingRevision: 2 },
        { onResponse: vi.fn() }
      )
    ).rejects.toThrow('The paired Orca server changed')
    expect(observer).toHaveBeenCalledOnce()
  })

  it('refuses an absent, unverified or unsupported primary without acquiring one', async () => {
    const before = CrewSocket.sockets.length
    expect(await subscribe(args, { onResponse: vi.fn() })).toMatchObject({
      ok: false,
      failure: { fact: { kind: 'source-retired' } }
    })
    expect(session.webRuntimeState.activeClient).toBeNull()
    expect(CrewSocket.sockets).toHaveLength(before)
    const client = session.getClientForEnvironment(environment)
    expect(await subscribe(args, { onResponse: vi.fn() })).toMatchObject({ ok: false })
    expect(CrewSocket.sockets).toHaveLength(before + 1)
    await verifyCrewPrimary(client)
    const snapshot = client.statusOwner!.read()
    client.statusOwner!.acceptVerified({
      id: 'status',
      ok: true,
      result: { ...snapshot.status!, capabilities: [] },
      _meta: { runtimeId: 'rt' }
    })
    expect(await subscribe(args, { onResponse: vi.fn() })).toMatchObject({
      ok: false,
      failure: { fact: { kind: 'host-unsupported' } }
    })
    expect(CrewSocket.sockets).toHaveLength(before + 1)
  })

  it('does not invoke before start or after pre-cancel and cancels immediate pending and retained actual handles', async () => {
    await verifyCrewPrimary(session.getClientForEnvironment(environment))
    const actualSubscribe = vi.spyOn(api, 'subscribeCrewAttempt')
    const { createRuntimeCrewSubscriptionAttempt } =
      await import('../runtime/runtime-crew-subscribe')
    const source = {
      selector: 'host',
      expectedEnvironmentPairingRevision: 1,
      expectedEnvironmentRuntimeId: 'rt'
    }
    const before = createRuntimeCrewSubscriptionAttempt(source, { onResponse: vi.fn() })
    expect(actualSubscribe).not.toHaveBeenCalled()
    before.cancel()
    await expect(before.start()).rejects.toMatchObject({ fact: { kind: 'cancelled' } })
    expect(actualSubscribe).not.toHaveBeenCalled()
    const pending = createRuntimeCrewSubscriptionAttempt(source, { onResponse: vi.fn() })
    const request = pending.start()
    expect(actualSubscribe).toHaveBeenCalledOnce()
    expect(actualSubscribe.mock.calls[0]?.[0]).toMatchObject({
      subscriptionId: pending.subscriptionId,
      timeoutMs: 15_000,
      selector: 'host',
      expectedEnvironmentRuntimeId: 'rt'
    })
    const pendingSocket = latestCrewSocket()
    pending.cancel()
    await expect(request).rejects.toMatchObject({ fact: { kind: 'cancelled' } })
    expect(pendingSocket.close).toHaveBeenCalledOnce()
    const retained = createRuntimeCrewSubscriptionAttempt(source, { onResponse: vi.fn() })
    const live = retained.start(),
      socket = await ready()
    await live
    retained.cancel()
    retained.cancel()
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('maps a real returned auth verdict to one renderer Error with the safe message/code and same observed promise', async () => {
    const pairing = await import('../runtime/runtime-environment-pairing-refresh')
    const observer = vi.spyOn(pairing, 'observePairingRefusal')
    await verifyCrewPrimary(session.getClientForEnvironment(environment))
    const { createWebRuntimeUnauthorizedError } = await import('./web-runtime-client-error')
    const { createRuntimeCrewSubscriptionAttempt } =
      await import('../runtime/runtime-crew-subscribe')
    const attempt = createRuntimeCrewSubscriptionAttempt(args, { onResponse: vi.fn() })
    const request = attempt.start()
    const rejected = request.catch((error: unknown) => error)
    const socket = latestCrewSocket()
    socket.open()
    socket.ready()
    await flushCrewWork()
    socket.frame({ type: 'e2ee_error', code: 'unauthorized' })
    expect(await rejected).toMatchObject({
      message: createWebRuntimeUnauthorizedError().message,
      code: 'unauthorized',
      fact: { kind: 'remote', code: 'unauthorized' }
    })
    expect(observer).toHaveBeenCalledExactlyOnceWith(request)
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('preserves an unexpected bridge rejection instead of inventing a normal setup fact', async () => {
    const error = new Error('Native invoke failed outside the result contract')
    vi.spyOn(api, 'subscribeCrewAttempt').mockRejectedValueOnce(error)
    const { createRuntimeCrewSubscriptionAttempt } =
      await import('../runtime/runtime-crew-subscribe')
    const request = createRuntimeCrewSubscriptionAttempt(args, { onResponse: vi.fn() }).start()
    expect(await request.catch((failure: unknown) => failure)).toBe(error)
  })

  it('preserves the default pending-ID and abort rejection contract through the actual API', async () => {
    const ordinary = api.subscribe(legacyArgs, { onResponse: vi.fn() })
    const rejected = expect(ordinary).rejects.toMatchObject({ name: 'AbortError' })
    const cancellation = api.cancelSubscription({ subscriptionId: 'crew' })
    await expect(api.subscribe(legacyArgs, { onResponse: vi.fn() })).rejects.toThrow(
      'Subscription id already exists'
    )
    await cancellation
    await rejected
    expect(latestCrewSocket().close).toHaveBeenCalledOnce()
  })

  it.each(['before-result', 'after-result'] as const)(
    'keeps terminal %s ordering and frees the exact ID for re-entry',
    async (order) => {
      await verifyCrewPrimary(session.getClientForEnvironment(environment))
      const onClose = vi.fn(),
        onResponse = vi.fn()
      const pending = subscribe(args, { onResponse, onClose })
      const socket = latestCrewSocket()
      socket.open()
      socket.ready()
      await flushCrewWork()
      let requestId: string | undefined
      socket.send.mockImplementation(() => {
        const request: unknown = socket.read(2)
        if (
          !request ||
          typeof request !== 'object' ||
          !('id' in request) ||
          typeof request.id !== 'string'
        ) {
          throw new Error('No request ID')
        }
        requestId = request.id
        if (order === 'before-result') {
          socket.frame({
            id: requestId,
            ok: true,
            result: { type: 'end' },
            _meta: { runtimeId: 'rt' }
          })
        }
      })
      socket.authenticated()
      expect(await pending).toEqual({ subscriptionId: 'crew', ok: true })
      if (order === 'after-result') {
        socket.frame({
          id: requestId,
          ok: true,
          result: { type: 'end' },
          _meta: { runtimeId: 'rt' }
        })
      }
      expect(onClose).toHaveBeenCalledOnce()
      expect(onResponse).toHaveBeenCalledOnce()
      expect(socket.close).toHaveBeenCalledOnce()
      const again = subscribe(args, { onResponse: vi.fn() })
      await api.cancelSubscription({ subscriptionId: 'crew' })
      expect(await again).toMatchObject({ ok: false, failure: { fact: { kind: 'cancelled' } } })
    }
  )

  it.each(['source', 'runtime', 'disconnect', 'remove'] as const)(
    'fences actual %s retirement and does not adopt successor source',
    async (change) => {
      await verifyCrewPrimary(session.getClientForEnvironment(environment))
      const onResponse = vi.fn()
      const pending = subscribe(args, { onResponse })
      const socket = latestCrewSocket()
      if (change === 'source') {
        session.webRuntimeState.activeEnvironment = { ...environment, pairingRevision: 2 }
      }
      if (change === 'runtime') {
        session.webRuntimeState.activeEnvironment = { ...environment, runtimeId: 'successor' }
      }
      if (change === 'disconnect') {
        await api.disconnect({ selector: 'host' })
      }
      if (change === 'remove') {
        await api.remove({ selector: 'host' })
      }
      if (change === 'source' || change === 'runtime') {
        socket.open()
      }
      const result = await pending
      expect(result).toMatchObject({
        ok: false,
        failure: {
          fact: { kind: change === 'disconnect' ? 'manual-disconnect' : 'source-retired' }
        }
      })
      expect(onResponse).not.toHaveBeenCalled()
      expect(socket.send).not.toHaveBeenCalled()
      expect(socket.close).toHaveBeenCalledOnce()
    }
  )

  it('rechecks queued source, accepts equal source publications and refuses unverified null and refuses duplicate IDs without removing the original', async () => {
    await verifyCrewPrimary(session.getClientForEnvironment(environment))
    const pending = subscribe(args, { onResponse: vi.fn() })
    session.webRuntimeState.activeEnvironment = { ...environment, updatedAt: 100 }
    expect(await subscribe(args, { onResponse: vi.fn() })).toMatchObject({
      ok: false,
      failure: { fact: { kind: 'input' } }
    })
    await ready()
    expect(await pending).toEqual({ subscriptionId: 'crew', ok: true })
    await api.cancelSubscription({ subscriptionId: 'crew' })
    const held = Promise.withResolvers<void>()
    const blockers = Array.from({ length: 8 }, () =>
      session.runtimeCallQueuePool.enqueue('host', 'test.hold', () => held.promise)
    )
    const queued = subscribe({ ...args, subscriptionId: 'queued' }, { onResponse: vi.fn() })
    const count = CrewSocket.sockets.length
    session.webRuntimeState.activeEnvironment = { ...environment, pairingRevision: 2 }
    held.resolve()
    await Promise.all(blockers)
    expect(await queued).toMatchObject({ ok: false, failure: { fact: { kind: 'source-retired' } } })
    expect(CrewSocket.sockets).toHaveLength(count)
    session.webRuntimeState.activeEnvironment = { ...environment, runtimeId: null }
    const legacy = subscribe(
      { ...args, expectedEnvironmentRuntimeId: null },
      { onResponse: vi.fn() }
    )
    const before = CrewSocket.sockets.length
    expect(await legacy).toMatchObject({ ok: false, failure: { fact: { kind: 'source-retired' } } })
    expect(CrewSocket.sockets).toHaveLength(before)
    await api.cancelSubscription({ subscriptionId: 'crew' })
  })

  it.each([
    { count: 1, reject: false },
    { count: 10, reject: false },
    { count: 1, reject: true },
    { count: 10, reject: true }
  ])(
    'removes $count queued crew obligations before prerequisite settlement (reject=$reject), without late acquisition',
    async ({ count, reject }) => {
      await verifyCrewPrimary(session.getClientForEnvironment(environment))
      const enqueue = vi.spyOn(session.runtimeCallQueuePool, 'enqueue')
      const held = Promise.withResolvers<void>()
      const blockers = Array.from({ length: 8 }, () =>
        session.runtimeCallQueuePool.enqueue('host', 'test.hold', () => held.promise)
      )
      const pending: ReturnType<typeof subscribe>[] = []
      for (let index = 0; index < count; index++) {
        pending.push(subscribe(args, { onResponse: vi.fn() }))
        void api.cancelSubscription({ subscriptionId: 'crew' })
      }
      const drained = Promise.allSettled(blockers)
      const results = await Promise.all(pending)
      expect(
        results.every((result) => !result.ok && result.failure.fact.kind === 'cancelled')
      ).toBe(true)
      expect(enqueue).toHaveBeenCalledTimes(8 + count)
      const queueOwner: object = session.runtimeCallQueuePool
      const queued: unknown =
        'queuedCallCount' in queueOwner ? queueOwner.queuedCallCount : undefined
      expect(queued).toBe(0)
      expect(CrewSocket.sockets).toHaveLength(1) // Only the unchanged primary exists.
      if (reject) {
        held.reject(new Error('Held queue prerequisite rejected'))
      } else {
        held.resolve()
      }
      const settlements = await drained
      expect(
        settlements.every((result) => result.status === (reject ? 'rejected' : 'fulfilled'))
      ).toBe(true)
      await flushCrewWork()
      expect(CrewSocket.sockets).toHaveLength(1)
      const queues: unknown = 'queues' in queueOwner ? queueOwner.queues : undefined
      expect(queues instanceof Map && queues.size).toBe(0)
    }
  )
})
