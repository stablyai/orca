import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  gitBulkDiscardStaged.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      git: { bulkDiscardStaged: gitBulkDiscardStaged },
      runtime: { call: vi.fn() },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('runtime staged discard client', () => {
  it('uses one local staged discard IPC without exposing bulk unstage', async () => {
    gitBulkDiscardStaged.mockResolvedValue(undefined)

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
      connectionId: 'ssh-1'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it.each([
    ['absent', undefined],
    ['empty', []],
    ['malformed', GIT_STAGED_DISCARD_RUNTIME_CAPABILITY],
    ['unsupported', ['git.staged-discard.v2']],
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
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })

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
        stagedDiscardOperationVersion: 1
      },
      timeoutMs: 15_000
    })
  })
})
