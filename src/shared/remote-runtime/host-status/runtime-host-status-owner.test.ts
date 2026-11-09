import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeHostStatusOwner } from './runtime-host-status-owner'
import { runtimeHostStatusFailure, type RuntimeHostStatusResponse } from './runtime-host-status'
import type { RuntimeStatus } from '../../runtime-session-contracts'

const owners: RuntimeHostStatusOwner[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.dispose())
  vi.useRealTimers()
})
function success(runtimeId = 'host-1'): RuntimeHostStatusResponse & { ok: true } {
  return {
    id: 'status',
    ok: true,
    result: { runtimeId, capabilities: [] } as unknown as RuntimeStatus,
    _meta: { runtimeId }
  }
}
function deferred() {
  let resolve!: (response: RuntimeHostStatusResponse) => void
  const promise = new Promise<RuntimeHostStatusResponse>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function createOwner(persistent = false) {
  const request = vi
    .fn<(signal: AbortSignal) => Promise<RuntimeHostStatusResponse>>()
    .mockResolvedValue(success())
  const publish = vi.fn()
  const verified = vi.fn((_response: RuntimeHostStatusResponse, _active: boolean) => persistent)
  const owner = new RuntimeHostStatusOwner({
    environmentId: 'env-a',
    pairingRevision: 1,
    persistent,
    request,
    publish,
    verified
  })
  owners.push(owner)
  return { owner, request, publish, verified }
}

it('shares one verification between viewers with independent deadlines', async () => {
  const { owner, request } = createOwner()
  const pending = deferred()
  request.mockReturnValue(pending.promise)
  const impatient = owner.refresh({ timeoutMs: 100 })
  const patient = owner.refresh({ timeoutMs: 1_000 })
  await vi.advanceTimersByTimeAsync(100)
  expect((await impatient).ok).toBe(false)
  expect(request).toHaveBeenCalledOnce()
  expect(request.mock.calls[0][0].aborted).toBe(false)
  pending.resolve(success())
  expect((await patient).ok).toBe(true)
})

it('retries a failed status operation while retaining healthy transport and last good metadata', async () => {
  const { owner, request } = createOwner(true)
  owner.connectionChanged('ready')
  await owner.refresh()
  request.mockResolvedValueOnce(runtimeHostStatusFailure('runtime_unavailable', 'status timed out'))
  await owner.refresh()
  expect(owner.read()).toMatchObject({
    transport: 'ready',
    verification: 'unavailable',
    status: { runtimeId: 'host-1' }
  })
  await vi.advanceTimersByTimeAsync(3_000)
  expect(owner.read().verification).toBe('verified')
  expect(request).toHaveBeenCalledTimes(3)
})

it('retires a lost-socket request before explicit fallback and rejects its late result', async () => {
  const { owner, request } = createOwner(true)
  owner.connectionChanged('ready')
  const old = deferred()
  request.mockReturnValueOnce(old.promise)
  const waiting = owner.refresh()
  owner.connectionChanged('disconnected')
  expect(request.mock.calls[0][0].aborted).toBe(true)
  request.mockResolvedValueOnce(success('fallback-host'))
  expect((await owner.refresh()).ok).toBe(true)
  expect((await waiting).ok).toBe(true)
  old.resolve(success('obsolete-host'))
  await vi.advanceTimersByTimeAsync(0)
  expect(owner.read().status?.runtimeId).toBe('fallback-host')
  owner.connectionChanged('ready')
  await vi.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledTimes(3)
})

it('disconnect settles readers and prevents late results and retry resurrection', async () => {
  const { owner, request, publish } = createOwner()
  const old = deferred()
  request.mockReturnValue(old.promise)
  const waiting = owner.refresh()
  owner.dispose()
  expect((await waiting).ok).toBe(false)
  const sequence = owner.read().sequence
  old.resolve(success())
  owner.connectionChanged('ready')
  await vi.advanceTimersByTimeAsync(300_000)
  expect(owner.read()).toMatchObject({ retired: true, sequence })
  expect(publish.mock.lastCall?.[0].retired).toBe(true)
  expect(request).toHaveBeenCalledOnce()
})

it('authentication rejection blocks automatic verification until explicit reconnect', async () => {
  const { owner, request } = createOwner(true)
  owner.connectionChanged('ready')
  request.mockResolvedValueOnce(runtimeHostStatusFailure('unauthorized', 're-pair'))
  await owner.refresh()
  owner.connectionChanged('disconnected')
  owner.connectionChanged('ready')
  await vi.advanceTimersByTimeAsync(300_000)
  expect(request).toHaveBeenCalledOnce()
  expect((await owner.refresh({ reconnect: true })).ok).toBe(true)
})

it('cancelling one reader leaves the shared request available to other readers', async () => {
  const { owner, request } = createOwner()
  const pending = deferred()
  request.mockReturnValue(pending.promise)
  const controller = new AbortController()
  const cancelled = owner.refresh({ signal: controller.signal })
  const remaining = owner.refresh()
  const rejection = expect(cancelled).rejects.toThrow('cancelled')
  controller.abort(new Error('cancelled'))
  await rejection
  expect(request.mock.calls[0][0].aborted).toBe(false)
  pending.resolve(success())
  expect((await remaining).ok).toBe(true)
})

it('does not let one failed boot probe keep a host unavailable (#16516)', async () => {
  const { owner, request } = createOwner()
  request.mockResolvedValueOnce(runtimeHostStatusFailure('runtime_unavailable', 'host asleep'))
  await owner.refresh()
  expect(owner.read().verification).toBe('unavailable')
  await vi.advanceTimersByTimeAsync(3_000)
  expect(owner.read()).toMatchObject({
    verification: 'verified',
    status: { runtimeId: 'host-1' }
  })
})

it('re-verifies a persistent host when its transport returns, without another explicit probe', async () => {
  const { owner, request } = createOwner(true)
  owner.connectionChanged('ready')
  await owner.refresh()
  owner.connectionChanged('disconnected')
  expect(owner.read().verification).toBe('unavailable')
  owner.connectionChanged('ready')
  await vi.advanceTimersByTimeAsync(0)
  expect(owner.read().verification).toBe('verified')
  expect(request).toHaveBeenCalledTimes(2)
})
