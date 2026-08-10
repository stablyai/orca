import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_STAGED_DISCARD_OPERATION_VERSION,
  GIT_STAGED_DISCARD_RUNTIME_CAPABILITY,
  GIT_STAGED_DISCARD_UPDATE_REQUIRED_MESSAGE
} from '../../../shared/protocol-version'
import { bulkDiscardStagedRuntimeGitPaths } from './runtime-git-client'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const gitBulkDiscardStaged = vi.fn()
const gitGetStagedDiscardReceipt = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

function paramsOf(args: RuntimeEnvironmentCallRequest): unknown {
  return (args as RuntimeEnvironmentCallRequest & { params?: unknown }).params
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  gitBulkDiscardStaged.mockReset()
  gitGetStagedDiscardReceipt.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      git: {
        bulkDiscardStaged: gitBulkDiscardStaged,
        getStagedDiscardReceipt: gitGetStagedDiscardReceipt
      },
      runtime: { call: vi.fn() },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('runtime staged discard client', () => {
  it('uses one local staged discard IPC without exposing bulk unstage', async () => {
    gitBulkDiscardStaged.mockImplementation(async ({ operationId }) => ({
      operationId,
      state: 'succeeded',
      mutation: 'complete',
      affectedPaths: ['staged.txt'],
      completedPaths: ['staged.txt'],
      uncertainPaths: [],
      remainingPaths: []
    }))

    await bulkDiscardStagedRuntimeGitPaths(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: 'ssh-1'
      },
      ['staged.txt']
    )

    expect(gitBulkDiscardStaged).toHaveBeenCalledWith({
      worktreePath: '/repo',
      filePaths: ['staged.txt'],
      operationId: expect.any(String),
      connectionId: 'ssh-1'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('polls direct SSH IPC until the outer receipt settles', async () => {
    gitBulkDiscardStaged.mockImplementation(async ({ operationId }) => ({
      operationId,
      state: 'pending',
      mutation: 'possible',
      affectedPaths: ['staged.txt'],
      completedPaths: [],
      uncertainPaths: ['staged.txt'],
      remainingPaths: []
    }))
    gitGetStagedDiscardReceipt.mockImplementation(async ({ operationId }) => ({
      operationId,
      state: 'succeeded',
      mutation: 'complete',
      affectedPaths: ['staged.txt'],
      completedPaths: ['staged.txt'],
      uncertainPaths: [],
      remainingPaths: []
    }))

    await expect(
      bulkDiscardStagedRuntimeGitPaths(
        {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          connectionId: 'ssh-1'
        },
        ['staged.txt']
      )
    ).resolves.toMatchObject({ state: 'succeeded' })
    expect(gitGetStagedDiscardReceipt).toHaveBeenCalledWith({
      worktreePath: '/repo',
      operationId: expect.any(String),
      connectionId: 'ssh-1'
    })
  })

  it.each([
    ['absent', undefined],
    ['empty', []],
    ['malformed', GIT_STAGED_DISCARD_RUNTIME_CAPABILITY],
    ['unsupported', ['git.staged-discard.v1']],
    ['mixed malformed', [GIT_STAGED_DISCARD_RUNTIME_CAPABILITY, 1]]
  ])('fails closed when staged discard capability is %s', async (_label, capabilities) => {
    runtimeEnvironmentTransportCall.mockImplementation(
      async (args: RuntimeEnvironmentCallRequest) => {
        if (args.method === 'status.get') {
          const response = createCompatibleRuntimeStatusResponse()
          if (!response.ok) {
            throw new Error('Expected compatible status fixture')
          }
          return { ...response, result: { ...response.result, capabilities } }
        }
        return runtimeEnvironmentCall(args)
      }
    )

    await expect(
      bulkDiscardStagedRuntimeGitPaths(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/repo'
        },
        ['staged.txt']
      )
    ).rejects.toThrow(GIT_STAGED_DISCARD_UPDATE_REQUIRED_MESSAGE)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('calls the versioned staged discard RPC only after owner capability proof', async () => {
    runtimeEnvironmentTransportCall.mockImplementation(
      async (args: RuntimeEnvironmentCallRequest) => {
        if (args.method === 'status.get') {
          const response = createCompatibleRuntimeStatusResponse()
          if (!response.ok) {
            throw new Error('Expected compatible status fixture')
          }
          return {
            ...response,
            result: {
              ...response.result,
              capabilities: [GIT_STAGED_DISCARD_RUNTIME_CAPABILITY]
            }
          }
        }
        return runtimeEnvironmentCall(args)
      }
    )
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => ({
      id: 'rpc-1',
      ok: true,
      result: {
        operationId: (paramsOf(args) as { operationId: string }).operationId,
        state: 'succeeded',
        mutation: 'complete',
        affectedPaths: ['staged.txt'],
        completedPaths: ['staged.txt'],
        uncertainPaths: [],
        remainingPaths: []
      },
      _meta: { runtimeId: 'remote-runtime' }
    }))

    await bulkDiscardStagedRuntimeGitPaths(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      ['staged.txt']
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'git.bulkDiscardStaged',
      params: {
        worktree: 'id:wt-1',
        filePaths: ['staged.txt'],
        operationId: expect.any(String),
        stagedDiscardOperationVersion: GIT_STAGED_DISCARD_OPERATION_VERSION
      },
      timeoutMs: 15_000
    })
  })

  it('returns the host receipt after a timed-out mutation acknowledgement', async () => {
    let receiptReads = 0
    runtimeEnvironmentTransportCall.mockImplementation(
      async (args: RuntimeEnvironmentCallRequest) => {
        if (args.method === 'status.get') {
          const response = createCompatibleRuntimeStatusResponse()
          if (!response.ok) {
            throw new Error('Expected compatible status fixture')
          }
          return {
            ...response,
            result: {
              ...response.result,
              capabilities: [GIT_STAGED_DISCARD_RUNTIME_CAPABILITY]
            }
          }
        }
        return runtimeEnvironmentCall(args)
      }
    )
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'git.bulkDiscardStaged') {
        throw new Error('request timed out')
      }
      receiptReads += 1
      return {
        id: 'receipt',
        ok: true,
        result:
          receiptReads === 1
            ? {
                operationId: (paramsOf(args) as { operationId: string }).operationId,
                state: 'pending',
                mutation: 'possible',
                affectedPaths: ['staged.txt'],
                completedPaths: [],
                uncertainPaths: ['staged.txt'],
                remainingPaths: []
              }
            : {
                operationId: (paramsOf(args) as { operationId: string }).operationId,
                state: 'succeeded',
                mutation: 'complete',
                affectedPaths: ['staged.txt'],
                completedPaths: ['staged.txt'],
                uncertainPaths: [],
                remainingPaths: []
              },
        _meta: { runtimeId: 'remote-runtime' }
      }
    })

    await expect(
      bulkDiscardStagedRuntimeGitPaths(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/repo'
        },
        ['staged.txt']
      )
    ).resolves.toMatchObject({ state: 'succeeded', mutation: 'complete' })

    const mutation = runtimeEnvironmentCall.mock.calls[0]?.[0] as RuntimeEnvironmentCallRequest
    const recovery = runtimeEnvironmentCall.mock.calls[1]?.[0] as RuntimeEnvironmentCallRequest
    expect(recovery.method).toBe('git.getStagedDiscardReceipt')
    expect(paramsOf(recovery)).toMatchObject({
      operationId: (paramsOf(mutation) as { operationId: string }).operationId
    })
    expect(receiptReads).toBe(2)
  })

  it('keeps the operation pending after losing both mutation and first receipt transports', async () => {
    let receiptReads = 0
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'git.bulkDiscardStaged') {
        throw new Error('mutation transport lost')
      }
      receiptReads += 1
      if (receiptReads === 1) {
        throw new Error('first receipt transport lost')
      }
      const operationId = (paramsOf(args) as { operationId: string }).operationId
      return {
        id: `receipt-${receiptReads}`,
        ok: true,
        result:
          receiptReads === 2
            ? {
                operationId,
                state: 'pending',
                mutation: 'possible',
                affectedPaths: ['staged.txt'],
                completedPaths: [],
                uncertainPaths: ['staged.txt'],
                remainingPaths: []
              }
            : {
                operationId,
                state: 'succeeded',
                mutation: 'complete',
                affectedPaths: ['staged.txt'],
                completedPaths: ['staged.txt'],
                uncertainPaths: [],
                remainingPaths: []
              },
        _meta: { runtimeId: 'remote-runtime' }
      }
    })

    await expect(
      bulkDiscardStagedRuntimeGitPaths(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/repo'
        },
        ['staged.txt']
      )
    ).resolves.toMatchObject({ state: 'succeeded' })
    expect(receiptReads).toBe(3)
  })

  it('cancels an in-flight transport without waiting for its timeout', async () => {
    let resolveMutation!: (value: unknown) => void
    runtimeEnvironmentCall.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMutation = resolve
        })
    )
    const controller = new AbortController()
    const result = bulkDiscardStagedRuntimeGitPaths(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      ['staged.txt'],
      controller.signal
    )
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))

    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    resolveMutation({
      id: 'late',
      ok: true,
      result: null,
      _meta: { runtimeId: 'remote-runtime' }
    })
  })
})
