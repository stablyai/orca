import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'

const { callRuntimeRpcMock } = vi.hoisted(() => ({ callRuntimeRpcMock: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: callRuntimeRpcMock }))

import { preflightCreatedWorktreeAgentTrust } from './created-worktree-agent-trust'

describe('preflightCreatedWorktreeAgentTrust', () => {
  const markTrusted = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    callRuntimeRpcMock.mockResolvedValue(undefined)
    globalThis.window = { api: { agentTrust: { markTrusted } } } as never
  })

  it('uses the exact SSH owner when duplicate repository ids are present', async () => {
    const state = {
      repos: [
        { id: 'repo-1', executionHostId: 'local' },
        { id: 'repo-1', connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }
      ]
    } as unknown as AppState

    await preflightCreatedWorktreeAgentTrust(state, 'codex', {
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/ssh/worktree',
      hostId: 'ssh:ssh-1'
    })

    expect(markTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/ssh/worktree',
      connectionId: 'ssh-1'
    })
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })

  it('uses the runtime that owns the created workspace', async () => {
    const state = {
      repos: [{ id: 'repo-1', executionHostId: 'runtime:env-1' }]
    } as unknown as AppState

    await preflightCreatedWorktreeAgentTrust(state, 'codex', {
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/runtime/worktree',
      hostId: 'runtime:env-1',
      runtimeOwnerEnvironmentId: 'env-1'
    })

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'preflight.markAgentTrusted',
      { agent: 'codex', workspacePath: '/runtime/worktree' }
    )
    expect(markTrusted).not.toHaveBeenCalled()
  })
})
