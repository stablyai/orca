import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_COMMIT_AMEND_RUNTIME_CAPABILITY,
  GIT_COMMIT_AMEND_UPDATE_REQUIRED_MESSAGE
} from '../../../shared/source-control-runtime-capabilities'

const callRuntimeRpc = vi.fn()
const assertRuntimeEnvironmentCapability = vi.fn()

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args),
  assertRuntimeEnvironmentCapability: (...args: unknown[]) =>
    assertRuntimeEnvironmentCapability(...args)
}))

const { commitRuntimeGit } = await import('./runtime-git-sync-client')

const gitCommit = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  callRuntimeRpc.mockResolvedValue({ success: true })
  assertRuntimeEnvironmentCapability.mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { git: { commit: gitCommit } } })
})

describe('commitRuntimeGit amend routing', () => {
  it('sends amend through the local IPC bridge without a capability probe', async () => {
    gitCommit.mockResolvedValue({ success: true })

    await expect(
      commitRuntimeGit(
        { target: { kind: 'local' }, worktreeId: null, worktreePath: '/repo' },
        'feat: reword',
        true
      )
    ).resolves.toEqual({ success: true })

    expect(gitCommit).toHaveBeenCalledWith({
      worktreePath: '/repo',
      message: 'feat: reword',
      amend: true,
      connectionId: undefined
    })
    expect(assertRuntimeEnvironmentCapability).not.toHaveBeenCalled()
  })

  it('probes the amend capability before an environment amend RPC', async () => {
    await commitRuntimeGit(
      {
        target: { kind: 'environment', environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      'feat: reword',
      true
    )

    expect(assertRuntimeEnvironmentCapability).toHaveBeenCalledWith(
      'env-1',
      GIT_COMMIT_AMEND_RUNTIME_CAPABILITY,
      GIT_COMMIT_AMEND_UPDATE_REQUIRED_MESSAGE
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'git.commit',
      { worktree: 'id:wt-1', message: 'feat: reword', amend: true },
      { timeoutMs: 30_000 }
    )
  })

  it('skips the capability probe for a regular environment commit', async () => {
    await commitRuntimeGit(
      {
        target: { kind: 'environment', environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      'feat: new commit'
    )

    expect(assertRuntimeEnvironmentCapability).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'git.commit',
      { worktree: 'id:wt-1', message: 'feat: new commit' },
      { timeoutMs: 30_000 }
    )
  })

  it('surfaces the update-required error when the environment predates amend', async () => {
    assertRuntimeEnvironmentCapability.mockRejectedValue(
      new Error(GIT_COMMIT_AMEND_UPDATE_REQUIRED_MESSAGE)
    )

    await expect(
      commitRuntimeGit(
        {
          target: { kind: 'environment', environmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/repo'
        },
        'feat: reword',
        true
      )
    ).rejects.toThrow(GIT_COMMIT_AMEND_UPDATE_REQUIRED_MESSAGE)

    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})
