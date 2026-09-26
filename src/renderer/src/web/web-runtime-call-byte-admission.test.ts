import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

type CallRoute = 'active' | 'selected' | 'bound-files'

async function installBlockedCalls(route: CallRoute): Promise<{
  call: ReturnType<typeof vi.fn>
  send: (params: unknown) => Promise<unknown>
  release: () => void
  blockers: Promise<unknown>[]
}> {
  let release = (): void => {}
  const blocked = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
    release = () => resolve({ id: 'write', ok: true, result: null, _meta: { runtimeId: 'host' } })
  })
  const call = vi.fn(() => blocked)
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call = call
      close(): void {}
    }
  }))
  const { storage } = installBrowserGlobals()
  writeStoredRuntimeEnvironment(storage, 'web-server-a')
  const { callRuntimeEnvelope, callEnvironmentEnvelope } =
    await import('./preload-api/web-runtime-calls')
  const { captureWebFileMutationSession } = await import('./preload-api/web-filesystem-api')
  const session = captureWebFileMutationSession()
  const send = (params: unknown): Promise<unknown> => {
    if (route === 'bound-files') {
      return session.callRuntimeResult('files.write', params)
    }
    return route === 'active'
      ? callRuntimeEnvelope('files.write', params)
      : callEnvironmentEnvelope('web-server-a', 'files.write', params)
  }
  const blockers = Array.from({ length: 8 }, () => callRuntimeEnvelope('status.get'))
  expect(call).toHaveBeenCalledTimes(8)
  return { call, send, release, blockers }
}

function enqueueWrite(send: (params: unknown) => Promise<unknown>): {
  ref: WeakRef<object>
  settled: Promise<unknown>
} {
  const params = { worktree: 'id:wt-1', relativePath: 'note.txt', content: 'x'.repeat(1024 * 1024) }
  return { ref: new WeakRef(params), settled: send(params) }
}

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

describe('web runtime queued payload admission', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it.each<CallRoute>(['active', 'selected', 'bound-files'])(
    'rejects aggregate queued payload bytes through %s calls and recovers after drain',
    async (route) => {
      const { call, send, release, blockers } = await installBlockedCalls(route)
      const writes = Array.from({ length: 5 }, () =>
        send({
          worktree: 'id:wt-1',
          relativePath: 'note.txt',
          content: 'x'.repeat(2 * 1024 * 1024)
        })
      )
      let rejection: unknown
      const overflow = send({
        worktree: 'id:wt-1',
        relativePath: 'note.txt',
        content: 'x'.repeat(2 * 1024 * 1024)
      }).catch((error: unknown) => {
        rejection = error
      })
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(rejection).toMatchObject({ code: 'runtime_rpc_queue_overloaded', scope: 'memory' })
        expect(call).toHaveBeenCalledTimes(8)
      } finally {
        release()
        await Promise.allSettled([...blockers, ...writes, overflow])
      }
      await expect(
        send({ worktree: 'id:wt-1', content: 'x'.repeat(2 * 1024 * 1024) })
      ).resolves.toBeDefined()
    }
  )

  it.each<CallRoute>(['active', 'selected', 'bound-files'])(
    'retains only a JSON snapshot while a %s call waits',
    async (route) => {
      const { send, release, blockers } = await installBlockedCalls(route)
      const queued = enqueueWrite(send)
      try {
        await collect()
        expect(queued.ref.deref() === undefined).toBe(true)
      } finally {
        release()
        await Promise.allSettled([...blockers, queued.settled])
      }
    }
  )

  it('refuses one oversized request before it can enter the queue', async () => {
    const { call, send, release, blockers } = await installBlockedCalls('active')
    let rejection: unknown
    const oversized = send({ content: 'x'.repeat(4 * 1024 * 1024) }).catch((error: unknown) => {
      rejection = error
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(rejection).toMatchObject({ code: 'invalid_argument' })
      expect(call).toHaveBeenCalledTimes(8)
    } finally {
      release()
      await Promise.allSettled([...blockers, oversized])
    }
  })
})
