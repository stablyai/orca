import { afterEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES } from '../../../shared/remote-runtime-memory-limits'
import { getRemoteRuntimeRequestAdmissionEvidence } from '../../../shared/remote-runtime-prepared-request-admission'
import { RuntimeRpcCallQueuePool } from '../../../shared/runtime-rpc-call-queue'
import { createWebFileMutationMethods } from './web-file-mutation-methods'

function deferred() {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function blockedSession(stage: 'path' | 'capability' | 'ssh' | 'mutation') {
  const blocked = deferred()
  const calls: string[] = []
  const waitAt = async (name: string): Promise<void> => {
    calls.push(name)
    if (stage === name) {
      await blocked.promise
    }
  }
  const session = {
    resolveFilePath: async () => {
      await waitAt('path')
      return { worktree: { id: 'folder', hostId: 'ssh:target' as const }, relativePath: 'file' }
    },
    assertMutationSupported: () => waitAt('capability'),
    getSshState: async () => {
      await waitAt('ssh')
      return {
        targetId: 'target',
        status: 'connected' as const,
        error: null,
        reconnectAttempt: 0,
        connectionGeneration: 3
      }
    },
    callRuntimeResult: async () => waitAt('mutation')
  }
  return { session, calls, release: blocked.release }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('public web file mutation admission', () => {
  afterEach(() => {
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
  })

  it.each(['path', 'capability', 'ssh', 'mutation'] as const)(
    'bounds simultaneous file content while waiting for %s and returns capacity after completion',
    async (stage) => {
      const { session, calls, release } = blockedSession(stage)
      const failures: unknown[] = []
      const operations = Array.from({ length: 32 }, (_, index) => {
        const methods = createWebFileMutationMethods({ captureSession: () => session })
        return methods
          .writeFile({
            filePath: `/folder/${index}`,
            content: Buffer.alloc(2 * 1024 * 1024, (index % 26) + 65).toString('utf8')
          })
          .catch((error: unknown) => failures.push(error))
      })
      try {
        await flush()
        expect(failures).toHaveLength(27)
        expect(failures).toEqual(
          Array.from({ length: 27 }, () => expect.objectContaining({ code: 'remote_runtime_busy' }))
        )
        expect(calls.filter((name) => name === stage)).toHaveLength(5)
        const evidence = getRemoteRuntimeRequestAdmissionEvidence()
        expect(evidence.pendingRequestCount).toBe(5)
        expect(evidence.retainedBytes).toBeGreaterThan(30 * 1024 * 1024)
        expect(evidence.retainedBytes).toBeLessThanOrEqual(REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES)
      } finally {
        release()
        await Promise.all(operations)
      }
      const methods = createWebFileMutationMethods({ captureSession: () => session })
      await expect(
        methods.writeFile({ filePath: '/folder/next', content: 'next' })
      ).resolves.toBeUndefined()
    }
  )

  it('rejects oversized content before resolving a path', async () => {
    const { session, calls, release } = blockedSession('path')
    const methods = createWebFileMutationMethods({ captureSession: () => session })
    let failure: unknown
    const operation = methods
      .writeFile({ filePath: '/folder/file', content: '\u0000'.repeat(1024 * 1024) })
      .catch((error: unknown) => {
        failure = error
      })
    try {
      await flush()
      expect(failure).toMatchObject({ code: 'invalid_argument' })
      expect(calls).toEqual([])
    } finally {
      release()
      await operation
    }
  })

  it.each(['capture', 'path', 'capability', 'ssh', 'mutation'] as const)(
    'releases admission when %s fails',
    async (stage) => {
      const { session, release } = blockedSession('path')
      release()
      const failure = new Error(`${stage} failed`)
      const captureSession = () => {
        if (stage === 'capture') {
          throw failure
        }
        return session
      }
      if (stage === 'path') {
        session.resolveFilePath = vi.fn().mockRejectedValue(failure)
      }
      if (stage === 'capability') {
        session.assertMutationSupported = vi.fn().mockRejectedValue(failure)
      }
      if (stage === 'ssh') {
        session.getSshState = vi.fn().mockRejectedValue(failure)
      }
      if (stage === 'mutation') {
        session.callRuntimeResult = vi.fn().mockRejectedValue(failure)
      }
      const methods = createWebFileMutationMethods({ captureSession })
      await expect(
        methods.writeFile({ filePath: '/folder/file', content: 'x'.repeat(2 * 1024 * 1024) })
      ).rejects.toBe(failure)
    }
  )

  it('bounds small mutations together across API instances before their prerequisites start', async () => {
    const { session, calls, release } = blockedSession('path')
    const methods = createWebFileMutationMethods({ captureSession: () => session })
    const operations = Array.from({ length: 256 }, () =>
      methods.createFile({ filePath: '/folder/file' })
    )
    const replacement = createWebFileMutationMethods({ captureSession: () => session })
    try {
      const overflow = [
        replacement.createDir({ dirPath: '/folder/new' }),
        replacement.rename({ oldPath: '/folder/file', newPath: '/folder/new' }),
        replacement.copy({ sourcePath: '/folder/file', destinationPath: '/folder/new' }),
        replacement.deletePath({ targetPath: '/folder/file' }),
        replacement.writeFile({ filePath: '/folder/file', content: 'tiny' })
      ]
      await Promise.all(
        overflow.map((operation) =>
          expect(operation).rejects.toMatchObject({ code: 'remote_runtime_busy' })
        )
      )
      expect(calls).toHaveLength(256)
      expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(256)
    } finally {
      release()
      await Promise.all(operations)
    }
  })

  it('leaves RPC slots available to nested prerequisites and preserves write content', async () => {
    const queue = new RuntimeRpcCallQueuePool(1)
    const rpcMethods: string[] = []
    const received: unknown[] = []
    const rpc = <T>(method: string, result: T): Promise<T> =>
      queue.enqueueJson('paired', method, undefined, async () => {
        rpcMethods.push(method)
        return result
      })
    const methods = createWebFileMutationMethods({
      captureSession: () => ({
        resolveFilePath: async () =>
          rpc('worktree.list', {
            worktree: { id: 'folder', hostId: 'local' as const },
            relativePath: 'file'
          }),
        assertMutationSupported: async () => {
          await rpc('status.get', undefined)
        },
        getSshState: async () => null,
        callRuntimeResult: async (method, params) => {
          received.push(params)
          await rpc(method, undefined)
        }
      })
    })
    const contents = Array.from({ length: 12 }, (_, index) => `write ${index} \u2603 \u0000`)
    await Promise.all(
      contents.map((content) => methods.writeFile({ filePath: '/folder/file', content }))
    )
    expect(rpcMethods).toHaveLength(36)
    expect(received).toEqual(
      contents.map((content) => ({
        worktree: 'id:folder',
        relativePath: 'file',
        content,
        expectedExecutionHostId: 'local'
      }))
    )
  })
})
