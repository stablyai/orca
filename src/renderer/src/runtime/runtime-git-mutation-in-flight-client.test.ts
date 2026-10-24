import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeGitMutationInFlight } from './runtime-git-status-client'

const mocks = vi.hoisted(() => ({ local: vi.fn(), rpc: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))

describe('Git mutation-in-flight host routing', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('window', { api: { git: { mutationInFlight: mocks.local } } })
    mocks.local.mockResolvedValue({ inFlight: false })
    mocks.rpc.mockResolvedValue({ inFlight: true })
  })

  it('asks main for a local workspace using its filesystem path', async () => {
    await expect(
      getRuntimeGitMutationInFlight({
        target: { kind: 'local' },
        worktreeId: 'repo::/repo',
        worktreePath: '/wrong'
      })
    ).resolves.toEqual({ inFlight: false })
    expect(mocks.local).toHaveBeenCalledExactlyOnceWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('asks the owner runtime rather than this client', async () => {
    const target = { kind: 'environment' as const, environmentId: 'owner-host' }
    await expect(
      getRuntimeGitMutationInFlight({
        target,
        worktreeId: 'repo::/repo',
        worktreePath: '/repo',
        connectionId: 'nested-ssh'
      })
    ).resolves.toEqual({ inFlight: true })
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      target,
      'git.mutationInFlight',
      { worktree: 'id:repo::/repo' },
      { timeoutMs: 15_000 }
    )
    expect(mocks.local).not.toHaveBeenCalled()
  })
})
