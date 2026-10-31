import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebRuntimeClient } from './web-runtime-client'
import { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'
import { WebRuntimeConnectionWaiters } from './web-runtime-connection-waiters'
import { createSessionDeviceSigningKey } from './web-device-key'
import { RuntimeEnvironmentSetupGuardError } from '../../../shared/runtime-environment-subscription-setup'
import { createMemoryWebDeviceKeyStore } from './web-device-key-store'
import {
  createWebRuntimeCredentialSource,
  tokenOnlyCredentialSource,
  type WebRuntimeAuthPlan
} from './web-runtime-credential-source'
import {
  connection,
  CrewSocket,
  flushCrewWork,
  installCrewSocketGlobals,
  latestCrewSocket,
  publicKeyB64
} from './web-runtime-crew.test-fixture'

function transport(client: WebRuntimeClient): WebRuntimeConnectionTransport {
  const clientOwner: object = client
  const value: unknown = 'transport' in clientOwner ? clientOwner.transport : undefined
  if (!(value instanceof WebRuntimeConnectionTransport)) {
    throw new Error('Missing transport')
  }
  return value
}

function children(client: WebRuntimeClient): WebRuntimeClient[] {
  const clientOwner: object = client
  const value: unknown = 'childClients' in clientOwner ? clientOwner.childClients : undefined
  if (!(value instanceof Set)) {
    throw new Error('Missing children')
  }
  return [...value].map((child: unknown) => {
    if (!(child instanceof WebRuntimeClient)) {
      throw new Error('Invalid child')
    }
    return child
  })
}

function waiterCount(client: WebRuntimeClient): number {
  const transportOwner: object = transport(client)
  const owner: unknown =
    'connectionWaiters' in transportOwner ? transportOwner.connectionWaiters : undefined
  if (!(owner instanceof WebRuntimeConnectionWaiters)) {
    throw new Error('Missing wait owner')
  }
  const waiterOwner: object = owner
  const waiters: unknown = 'waiters' in waiterOwner ? waiterOwner.waiters : undefined
  if (!Array.isArray(waiters)) {
    throw new Error('Missing waiters')
  }
  return waiters.length
}

describe('finite crew child through actual browser transport/auth/waiter owners', () => {
  const clients: WebRuntimeClient[] = []
  const make = (options?: ConstructorParameters<typeof WebRuntimeClient>[1]): WebRuntimeClient => {
    const client = new WebRuntimeClient(connection, options)
    clients.push(client)
    return client
  }
  beforeEach(() => {
    vi.useFakeTimers()
    installCrewSocketGlobals()
  })
  afterEach(() => {
    CrewSocket.constructError = undefined
    for (const client of clients.splice(0)) {
      client.close()
    }
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('retains one real handle, closes it on release, and never enables the child reconnect ladder', async () => {
    const parent = make()
    const onResponse = vi.fn(),
      onClose = vi.fn()
    const pending = parent.subscribeCrewAttempt({}, { onResponse, onClose }, { timeoutMs: 15_000 })
    const child = children(parent)[0]
    const socket = latestCrewSocket()
    socket.open()
    socket.ready()
    await flushCrewWork()
    expect(socket.read(1)).toMatchObject({ type: 'e2ee_auth', deviceToken: 'token' })
    socket.authenticated()
    await flushCrewWork()
    const outcome = await pending
    expect(outcome.ok).toBe(true)
    expect(socket.read(2)).toMatchObject({ method: 'orchestration.crewSubscribe' })
    expect(transport(child).subscriptions.size).toBe(1)
    expect(waiterCount(child)).toBe(0)
    if (!outcome.ok) {
      throw new Error('Expected setup success')
    }
    outcome.value.unsubscribe()
    expect(transport(child).subscriptions.size).toBe(0)
    expect(children(parent)).toHaveLength(0)
    expect(socket.close).toHaveBeenCalledOnce()
    parent.close()
    const count = CrewSocket.sockets.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(CrewSocket.sockets).toHaveLength(count)
    expect(onResponse).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each(['false', 'throw'] as const)(
    'cleans the actual pre-send registration when send is %s',
    async (mode) => {
      const parent = make()
      const pending = parent.subscribeCrewAttempt({}, { onResponse: vi.fn() })
      const child = children(parent)[0],
        socket = latestCrewSocket()
      socket.open()
      socket.ready()
      await flushCrewWork()
      const error = new Error('actual send failure')
      if (mode === 'throw') {
        socket.send.mockImplementation(() => {
          throw error
        })
      }
      socket.authenticated()
      if (mode === 'false') {
        socket.readyState = 3
      }
      const result = await pending
      expect(result).toMatchObject({
        ok: false,
        failure: { fact: { kind: 'operation', operation: 'subscription' } }
      })
      if (mode === 'throw' && !result.ok) {
        expect(result.failure.error).toBe(error)
      }
      expect(transport(child).subscriptions.size).toBe(0)
      expect(waiterCount(child)).toBe(0)
      expect(children(parent)).toHaveLength(0)
      expect(socket.close).toHaveBeenCalledOnce()
    }
  )

  it.each(['constructor', 'hello', 'auth-send', 'close'] as const)(
    'settles and releases a finite %s failure',
    async (phase) => {
      const parent = make()
      const error = new Error(`${phase} failed`)
      if (phase === 'constructor') {
        CrewSocket.constructError = error
      }
      const pending = parent.subscribeCrewAttempt({}, { onResponse: vi.fn() })
      const socket = latestCrewSocket()
      if (phase === 'hello') {
        socket.send.mockImplementation(() => {
          throw error
        })
        socket.open()
      }
      if (phase === 'auth-send') {
        socket.open()
        socket.ready()
        socket.send.mockImplementation(() => {
          throw error
        })
      }
      if (phase === 'close') {
        socket.close.mockImplementation(() => {
          throw error
        })
        socket.send.mockImplementation(() => {
          throw new Error('hello primary failure')
        })
        socket.open()
      }
      const outcome = await pending
      expect(outcome).toMatchObject({ ok: false, failure: { fact: { kind: 'operation' } } })
      if (!outcome.ok && phase !== 'close') {
        expect(outcome.failure.error).toBe(error)
      }
      expect(children(parent)).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(1) // The unchanged primary connect timer remains.
      socket.close.mockImplementation(() => {})
    }
  )

  it.each(['resolve', 'reject'] as const)(
    'observes actual held signing %s without treating it as a server verdict',
    async (settle) => {
      const signing = Promise.withResolvers<void>()
      const key = createSessionDeviceSigningKey()
      const sign = vi.fn(async (message: Uint8Array) => {
        await signing.promise
        return key.sign(message)
      })
      const credential = {
        ...tokenOnlyCredentialSource('token'),
        nextPlan: () => ({ kind: 'device-key' as const, deviceId: 'mine', key: { ...key, sign } })
      }
      const parent = make({ credential })
      const pending = parent.subscribeCrewAttempt({}, { onResponse: vi.fn() })
      const socket = latestCrewSocket()
      socket.open()
      socket.ready()
      await flushCrewWork()
      expect(sign).toHaveBeenCalledOnce()
      const error = new Error('sign operation failed')
      if (settle === 'reject') {
        signing.reject(error)
      } else {
        signing.resolve()
      }
      await flushCrewWork()
      if (settle === 'resolve') {
        socket.authenticated()
        await flushCrewWork()
      }
      const outcome = await pending
      if (settle === 'reject') {
        expect(outcome).toEqual({
          ok: false,
          failure: { error, fact: { kind: 'operation', operation: 'subscription' } }
        })
      } else {
        expect(socket.read(1)).toMatchObject({ type: 'e2ee_auth', deviceId: 'mine' })
        expect(outcome.ok).toBe(true)
        if (outcome.ok) {
          outcome.value.unsubscribe()
        }
      }
    }
  )

  it.each(['returned', 'rejected', 'late'] as const)(
    'distinguishes %s actual async revocation verdict work',
    async (mode) => {
      const verdict = Promise.withResolvers<boolean>()
      const deviceRevoked = vi.fn(() => verdict.promise)
      const credential = {
        ...tokenOnlyCredentialSource('token'),
        deviceRevoked,
        nextPlan: () => ({
          kind: 'device-key' as const,
          deviceId: 'mine',
          key: createSessionDeviceSigningKey()
        })
      }
      const parent = make({ credential })
      const controller = new AbortController()
      const pending = parent.subscribeCrewAttempt(
        {},
        { onResponse: vi.fn() },
        { signal: controller.signal }
      )
      const socket = latestCrewSocket()
      socket.open()
      socket.ready()
      await flushCrewWork()
      socket.frame({ type: 'e2ee_error', error: { code: 'device_revoked', deviceId: 'mine' } })
      await flushCrewWork()
      expect(deviceRevoked).toHaveBeenCalledWith('mine')
      const error = new Error('store callback rejected')
      if (mode === 'late') {
        controller.abort()
      }
      if (mode === 'rejected') {
        verdict.reject(error)
      } else {
        verdict.resolve(true)
      }
      const outcome = await pending
      if (mode === 'returned') {
        expect(outcome).toMatchObject({
          ok: false,
          failure: {
            fact: { kind: 'remote', code: 'unauthorized' },
            error: { code: 'unauthorized' }
          }
        })
      }
      if (mode === 'rejected') {
        expect(outcome).toEqual({
          ok: false,
          failure: { error, fact: { kind: 'operation', operation: 'subscription' } }
        })
      }
      await flushCrewWork()
      expect(children(parent)).toHaveLength(0)
      expect(socket.close).toHaveBeenCalledOnce()
    }
  )

  it.each([1, 10])(
    'cancels %i real inner waits while actual credential-store operations remain held, then drains both outcomes',
    async (count) => {
      for (const result of ['resolve', 'reject'] as const) {
        const held = Promise.withResolvers<undefined>()
        const store = createMemoryWebDeviceKeyStore()
        const read = vi.spyOn(store, 'get').mockImplementation(() => held.promise)
        const credential = createWebRuntimeCredentialSource({
          environment: {
            environmentId: 'host',
            hostPublicKeyB64: publicKeyB64,
            deviceToken: 'migrated:mine',
            pairingRevision: 1,
            storage: 'persisted'
          },
          support: 'persistent',
          store,
          subtle: globalThis.crypto.subtle,
          forgetStoredToken: vi.fn(),
          forgetPairing: vi.fn()
        })
        const parent = make({ credential })
        const controllers = Array.from({ length: count }, () => new AbortController())
        const attempts = controllers.map((controller) =>
          parent.subscribeCrewAttempt(
            {},
            { onResponse: vi.fn() },
            { signal: controller.signal, timeoutMs: 15_000 }
          )
        )
        const retired = children(parent)
        expect(retired).toHaveLength(count)
        expect(retired.map(waiterCount)).toEqual(Array(count).fill(1))
        expect(read).toHaveBeenCalledTimes(count + 1)
        for (const controller of controllers) {
          controller.abort()
        }
        await Promise.all(attempts)
        expect(children(parent)).toHaveLength(0)
        expect(retired.map(waiterCount)).toEqual(Array(count).fill(0))
        expect(vi.getTimerCount()).toBe(0)
        const socketCount = CrewSocket.sockets.length
        parent.close()
        if (result === 'resolve') {
          held.resolve(undefined)
        } else {
          held.reject(new Error('held store rejected'))
        }
        await flushCrewWork()
        expect(CrewSocket.sockets).toHaveLength(socketCount)
        expect(read).toHaveBeenCalledTimes((count + 1) * (result === 'reject' ? 2 : 1))
        expect(vi.getTimerCount()).toBe(0)
      }
    }
  )

  it.each([1, 10])(
    'releases %i signing children before actual crypto settles and counts late resolve/reject work separately',
    async (count) => {
      for (const settle of ['resolve', 'reject'] as const) {
        const held = Promise.withResolvers<void>()
        const key = createSessionDeviceSigningKey()
        const cryptoSign = vi.fn(key.sign)
        let drained = 0
        const sign = vi.fn(async (message: Uint8Array) => {
          try {
            await held.promise
            return await cryptoSign(message)
          } finally {
            drained++
          }
        })
        const credential = {
          ...tokenOnlyCredentialSource('token'),
          nextPlan: () => ({ kind: 'device-key' as const, deviceId: 'mine', key: { ...key, sign } })
        }
        const parent = make({ credential }),
          onResponse = vi.fn()
        const controllers = Array.from({ length: count }, () => new AbortController())
        const pending = controllers.map((controller) =>
          parent.subscribeCrewAttempt({}, { onResponse }, { signal: controller.signal })
        )
        const retired = children(parent),
          sockets = CrewSocket.sockets.slice(-count)
        for (const socket of sockets) {
          socket.open()
          socket.ready()
        }
        await flushCrewWork()
        expect(sign).toHaveBeenCalledTimes(count)
        expect(drained).toBe(0)
        for (const controller of controllers) {
          controller.abort()
        }
        await Promise.all(pending)
        expect(retired.map(waiterCount)).toEqual(Array(count).fill(0))
        expect(children(parent)).toHaveLength(0)
        expect(
          sockets.every(
            (socket) => socket.close.mock.calls.length === 1 && socket.send.mock.calls.length === 1
          )
        ).toBe(true)
        parent.close()
        expect(vi.getTimerCount()).toBe(0)
        const socketCount = CrewSocket.sockets.length
        if (settle === 'resolve') {
          held.resolve()
        } else {
          held.reject(new Error('held sign rejected'))
        }
        await flushCrewWork()
        expect(drained).toBe(count)
        expect(cryptoSign).toHaveBeenCalledTimes(settle === 'resolve' ? count : 0)
        expect(sockets.every((socket) => socket.send.mock.calls.length === 1)).toBe(true)
        expect(CrewSocket.sockets).toHaveLength(socketCount)
        expect(onResponse).not.toHaveBeenCalled()
      }
    }
  )

  it('fences the captured principal after held signing before sending any authentication', async () => {
    const held = Promise.withResolvers<void>(),
      key = createSessionDeviceSigningKey()
    const credential = {
      ...tokenOnlyCredentialSource('token'),
      nextPlan: () => ({
        kind: 'device-key' as const,
        deviceId: 'mine',
        key: {
          ...key,
          sign: async (message: Uint8Array) => {
            await held.promise
            return key.sign(message)
          }
        }
      })
    }
    const parent = make({ credential })
    let current = true
    const pending = parent.subscribeCrewAttempt(
      {},
      { onResponse: vi.fn() },
      {
        assertCurrent: () => {
          if (!current) {
            throw new RuntimeEnvironmentSetupGuardError('Source retired', {
              kind: 'source-retired'
            })
          }
        }
      }
    )
    const socket = latestCrewSocket()
    socket.open()
    socket.ready()
    await flushCrewWork()
    current = false
    held.resolve()
    expect(await pending).toMatchObject({
      ok: false,
      failure: { fact: { kind: 'source-retired' } }
    })
    expect(socket.send).toHaveBeenCalledOnce()
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('keeps default omitted readiness at30s and supplied finite readiness at15s with the original default rejection', async () => {
    const held = Promise.withResolvers<WebRuntimeAuthPlan>()
    const credential = { ...tokenOnlyCredentialSource('token'), nextPlan: () => held.promise }
    const parent = make({ credential })
    const ordinary = parent.subscribe('files.search', {}, { onResponse: vi.fn() })
    const expected = expect(ordinary).rejects.toThrow('Timed out while connecting')
    const finite = parent.subscribeCrewAttempt({}, { onResponse: vi.fn() }, { timeoutMs: 15_000 })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await finite).toMatchObject({
      ok: false,
      failure: { error: { message: expect.stringContaining('Timed out while connecting') } }
    })
    expect(children(parent)).toHaveLength(1)
    expect(waiterCount(children(parent)[0])).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)
    await expected
    parent.close()
    held.resolve({ kind: 'legacy-token', deviceToken: 'token' })
    await flushCrewWork()
  })
})
