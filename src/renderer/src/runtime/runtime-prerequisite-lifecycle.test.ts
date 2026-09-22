import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteRuntimeRequestAdmissionEvidence } from '../../../shared/remote-runtime-prepared-request-admission'
import { RuntimeRpcCallQueuePool } from '../../../shared/runtime-rpc-call-queue'
import { callRuntimeRpc, clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { callRuntimeFileMutation } from './runtime-file-mutation-rpc'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

const target = { kind: 'environment', environmentId: 'paired' } as const

function deferredStatus() {
  let resolve = (_response: unknown): void => {}
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function installCall(call: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
}

describe('runtime prerequisite admission lifecycle', () => {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    replaceRuntimeEnvironmentRevisions([])
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
  })

  it('releases cancelled content before a shared compatibility check finishes', async () => {
    const status = deferredStatus()
    const call = vi.fn(() => status.promise)
    installCall(call)
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const request = callRuntimeRpc(
      target,
      'files.write',
      { content: 'x'.repeat(2 * 1024 * 1024) },
      { signal: controller.signal }
    )
    expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(1)
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1])
    status.resolve(createCompatibleRuntimeStatusResponse())
    await nextTurn()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('rejects an already-cancelled request before probing', async () => {
    const call = vi.fn()
    installCall(call)
    const controller = new AbortController()
    controller.abort()
    await expect(
      callRuntimeRpc(target, 'files.write', {}, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(call).not.toHaveBeenCalled()
  })

  it.each(['rpc', 'mutation'] as const)(
    'releases %s reservations when the host refuses a prerequisite',
    async (route) => {
      const call = vi.fn(async () => ({
        id: 'status',
        ok: false,
        error: { code: 'forbidden', message: 'Permission denied' }
      }))
      installCall(call)
      const params = { content: 'x'.repeat(2 * 1024 * 1024) }
      await expect(
        route === 'rpc'
          ? callRuntimeRpc(target, 'files.write', params)
          : callRuntimeFileMutation(target, 'files.write', params, 15_000)
      ).rejects.toThrow('Permission denied')
      expect(call).toHaveBeenCalledTimes(1)
    }
  )

  it('refuses an unsupported mutation host before sending the write', async () => {
    const response = createCompatibleRuntimeStatusResponse()
    if (response.ok) {
      response.result.capabilities = []
    }
    const call = vi.fn(async () => response)
    installCall(call)
    await expect(
      callRuntimeFileMutation(target, 'files.write', { content: 'payload' }, 15_000)
    ).rejects.toThrow()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('snapshots content and preserves captured pairing and SSH ownership through both prerequisite stages', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1, pairingRevision: 7 }])
    const status = deferredStatus()
    const call = vi.fn(({ method }: { method: string }) =>
      method === 'status.get'
        ? status.promise
        : Promise.resolve({ id: 'write', ok: true, result: null })
    )
    installCall(call)
    const params = {
      worktree: 'id:folder:notes',
      relativePath: 'file',
      content: 'original\u0000\u2603',
      expectedExecutionHostId: 'ssh:target',
      expectedSshTargetId: 'target',
      expectedSshConnectionGeneration: 4
    }
    const write = callRuntimeFileMutation(target, 'files.write', params, 15_000)
    params.content = 'later edit'
    params.expectedSshConnectionGeneration = 5
    replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1, pairingRevision: 8 }])
    status.resolve(createCompatibleRuntimeStatusResponse())
    await write
    expect(call.mock.calls.map(([args]) => args)).toEqual([
      expect.objectContaining({ method: 'status.get', expectedEnvironmentPairingRevision: 7 }),
      expect.objectContaining({ method: 'status.get', expectedEnvironmentPairingRevision: 7 }),
      expect.objectContaining({
        method: 'files.write',
        expectedEnvironmentPairingRevision: 7,
        params: { ...params, content: 'original\u0000\u2603', expectedSshConnectionGeneration: 4 }
      })
    ])
  })

  it('rejects oversized escaped JSON before probing', async () => {
    const call = vi.fn()
    installCall(call)
    await expect(
      callRuntimeRpc(target, 'files.write', { content: '\u0000'.repeat(1024 * 1024) })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('bounds tiny requests sharing one compatibility check and releases capacity after drain', async () => {
    const status = deferredStatus()
    const call = vi.fn(({ method }: { method: string }) =>
      method === 'status.get'
        ? status.promise
        : Promise.resolve({ id: method, ok: true, result: null })
    )
    installCall(call)
    const pending = Array.from({ length: 256 }, () => callRuntimeRpc(target, 'repo.list'))
    try {
      await expect(callRuntimeRpc(target, 'repo.list')).rejects.toMatchObject({
        code: 'remote_runtime_busy'
      })
      expect(call).toHaveBeenCalledTimes(1)
    } finally {
      status.resolve(createCompatibleRuntimeStatusResponse())
      await Promise.all(pending)
    }
    await expect(callRuntimeRpc(target, 'repo.list')).resolves.toBeNull()
  })

  it('leaves a single RPC slot available to nested prerequisite work', async () => {
    const queue = new RuntimeRpcCallQueuePool(1)
    const call = vi.fn(({ method }: { method: string }) =>
      queue.enqueue('paired', method, async () =>
        method === 'status.get'
          ? createCompatibleRuntimeStatusResponse()
          : { id: method, ok: true, result: null }
      )
    )
    installCall(call)
    await Promise.all(
      Array.from({ length: 12 }, () =>
        callRuntimeFileMutation(target, 'files.write', { content: 'payload' }, 15_000)
      )
    )
    expect(call.mock.calls.filter(([args]) => args.method === 'files.write')).toHaveLength(12)
  })
})
