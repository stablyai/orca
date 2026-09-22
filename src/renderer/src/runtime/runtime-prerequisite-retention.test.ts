import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteRuntimeRequestAdmissionEvidence } from '../../../shared/remote-runtime-prepared-request-admission'
import { callRuntimeRpc, clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { callRuntimeFileMutation } from './runtime-file-mutation-rpc'
import { writeRuntimeFile } from './runtime-file-mutation-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'

type Route = 'rpc' | 'mutation' | 'write-file'
const target = { kind: 'environment', environmentId: 'paired' } as const

function blockedStatus() {
  let release = (): void => {}
  const status = new Promise<unknown>((resolve) => {
    release = () => resolve(createCompatibleRuntimeStatusResponse())
  })
  let checks = 0,
    writes = 0
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: ({ method }: { method: string }) => {
          if (method === 'status.get') {
            checks++
            return status
          }
          writes++
          return Promise.resolve({ id: 'write', ok: true, result: null })
        }
      }
    }
  })
  return { release, checks: () => checks, writes: () => writes }
}

function send(route: Route, content: string): Promise<unknown> {
  if (route === 'write-file') {
    return writeRuntimeFile(
      {
        settings: { activeRuntimeEnvironmentId: 'paired' },
        worktreeId: 'folder:notes',
        worktreePath: '/notes'
      },
      '/notes/file',
      content
    )
  }
  const params = { worktree: 'id:folder:notes', relativePath: 'file', content }
  return route === 'rpc'
    ? callRuntimeRpc(target, 'files.write', params)
    : callRuntimeFileMutation(target, 'files.write', params, 15_000)
}

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 4; round++) {
    await nextTurn()
    globalThis.gc()
  }
}

describe('runtime prerequisite payload ownership', () => {
  beforeEach(() => clearRuntimeCompatibilityCacheForTests())
  afterEach(() => {
    vi.unstubAllGlobals()
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
  })

  it.each<Route>(['rpc', 'mutation', 'write-file'])(
    'bounds retained content before %s capability checks finish',
    async (route) => {
      const blocked = blockedStatus()
      const failures: unknown[] = []
      const pending = Array.from({ length: 32 }, (_, index) =>
        send(route, Buffer.alloc(2 * 1024 * 1024, (index % 26) + 65).toString('utf8')).catch(
          (error: unknown) => {
            failures.push(error)
          }
        )
      )
      try {
        await nextTurn()
        expect(failures).toHaveLength(27)
        expect(failures).toEqual(
          Array.from({ length: 27 }, () => expect.objectContaining({ code: 'remote_runtime_busy' }))
        )
        expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(5)
        expect(blocked.writes()).toBe(0)
        expect(blocked.checks()).toBe(route === 'rpc' ? 1 : 5)
      } finally {
        blocked.release()
        await Promise.all(pending)
      }
      expect(blocked.writes()).toBe(5)
      expect(failures).toHaveLength(27)
    }
  )

  it.each(['rpc', 'mutation'] as const)(
    'releases the original caller graph while %s waits',
    async (route) => {
      const blocked = blockedStatus()
      function enqueue() {
        const params = { content: 'content', unrelated: new ArrayBuffer(16 * 1024 * 1024) }
        return {
          ref: new WeakRef(params),
          promise:
            route === 'rpc'
              ? callRuntimeRpc(target, 'files.write', params)
              : callRuntimeFileMutation(target, 'files.write', params, 15_000)
        }
      }
      const request = enqueue()
      try {
        await collect()
        expect(request.ref.deref() === undefined).toBe(true)
      } finally {
        blocked.release()
        await request.promise
      }
    }
  )
})
