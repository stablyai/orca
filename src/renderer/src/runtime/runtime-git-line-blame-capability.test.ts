import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_LINE_BLAME_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  supportsCapability: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: (
    settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined
  ) => {
    const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
    return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
  },
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

const { getRuntimeGitLineBlame } = await import('./runtime-git-client')

const REMOTE_CONTEXT = {
  settings: { activeRuntimeEnvironmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/remote/repo'
}

describe('getRuntimeGitLineBlame capability gate', () => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.supportsCapability.mockReset()
  })

  it('returns null without calling the RPC when the host does not advertise blame', async () => {
    mocks.supportsCapability.mockResolvedValue(false)

    await expect(
      getRuntimeGitLineBlame(REMOTE_CONTEXT, { filePath: 'src/index.ts', line: 5 })
    ).resolves.toBeNull()

    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'env-1',
      GIT_LINE_BLAME_RUNTIME_CAPABILITY
    )
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('calls git.lineBlame once the host advertises the capability', async () => {
    const blame = {
      sha: 'a'.repeat(40),
      author: 'Neil',
      authorTimeMs: 1,
      summary: 's',
      isUncommitted: false
    }
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.callRuntimeRpc.mockResolvedValue(blame)

    await expect(
      getRuntimeGitLineBlame(REMOTE_CONTEXT, { filePath: 'src/index.ts', line: 5 })
    ).resolves.toEqual(blame)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(mocks.callRuntimeRpc.mock.calls[0][1]).toBe('git.lineBlame')
  })

  it('never gates the local path on the remote capability', async () => {
    const lineBlame = vi.fn().mockResolvedValue(null)
    ;(
      globalThis as unknown as { window: { api: { git: { lineBlame: typeof lineBlame } } } }
    ).window = { api: { git: { lineBlame } } }

    await expect(
      getRuntimeGitLineBlame(
        {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'wt-1',
          worktreePath: '/repo'
        },
        { filePath: 'src/index.ts', line: 5 }
      )
    ).resolves.toBeNull()

    expect(lineBlame).toHaveBeenCalledTimes(1)
    expect(mocks.supportsCapability).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
