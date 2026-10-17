// The preview read lane: a file outside the runtime worktree is served by the
// local lane when the execution host is local (a local Codex worker's runtime
// home), and stays a refusal when the host is remote — its file is not here.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fsReadFile, installRuntimeFileClientEnvironment } from './runtime-file-client-test-harness'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import { readRuntimeFilePreview } from './runtime-file-read-client'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import type * as RuntimeRpcClient from './runtime-rpc-client'

vi.mock('./runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClient>()
  return {
    ...actual,
    getActiveRuntimeTarget: vi.fn(),
    callRuntimeRpc: vi.fn()
  }
})

installRuntimeFileClientEnvironment()

const CHAT_IMAGE_ACCESS = { kind: 'chat-image' } as const

function environmentContext(
  overrides: Partial<RuntimeFileOperationArgs> = {}
): RuntimeFileOperationArgs {
  return {
    settings: { activeRuntimeEnvironmentId: 'env-1' },
    worktreeId: 'wt-1',
    worktreePath: 'C:\\repo\\worktree',
    expectedExecutionHostId: 'local',
    runtimeHostIsLocalMachine: true,
    ...overrides
  }
}

beforeEach(() => {
  vi.mocked(getActiveRuntimeTarget).mockReturnValue({
    kind: 'environment',
    environmentId: 'env-1'
  } as never)
})

describe('readRuntimeFilePreview', () => {
  it('serves a file outside the worktree from the local lane when the execution host is local', async () => {
    fsReadFile.mockResolvedValue({ content: 'AA==', isBinary: true, mimeType: 'image/png' })
    const runtimeHomeImage = 'C:\\Users\\me\\AppData\\Roaming\\orca\\codex-runtime-home\\image.png'

    const result = await readRuntimeFilePreview(
      environmentContext(),
      runtimeHomeImage,
      CHAT_IMAGE_ACCESS
    )

    expect(fsReadFile).toHaveBeenCalledWith({
      filePath: runtimeHomeImage,
      connectionId: undefined,
      access: CHAT_IMAGE_ACCESS
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(result).toEqual({ content: 'AA==', isBinary: true, mimeType: 'image/png' })
  })

  it('keeps refusing a file outside the worktree when the execution host is remote', async () => {
    await expect(
      readRuntimeFilePreview(
        environmentContext({
          expectedExecutionHostId: 'ssh:prod',
          runtimeHostIsLocalMachine: false
        }),
        'C:\\Users\\me\\AppData\\Roaming\\orca\\codex-runtime-home\\image.png',
        CHAT_IMAGE_ACCESS
      )
    ).rejects.toThrow('Remote file is outside the owning runtime worktree')

    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('keeps refusing a file outside the worktree when no access lane is given', async () => {
    await expect(
      readRuntimeFilePreview(
        environmentContext(),
        'C:\\Users\\me\\AppData\\Roaming\\orca\\codex-runtime-home\\image.png'
      )
    ).rejects.toThrow('Remote file is outside the owning runtime worktree')

    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('never falls back to the local lane when the context speaks over a connection', async () => {
    await expect(
      readRuntimeFilePreview(
        environmentContext({ connectionId: 'ssh-1' }),
        'C:\\Users\\me\\AppData\\Roaming\\orca\\codex-runtime-home\\image.png',
        CHAT_IMAGE_ACCESS
      )
    ).rejects.toThrow('Remote file is outside the owning runtime worktree')

    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('refuses a remote runtime environment whose path is not proven to be on this machine', async () => {
    // 'local' host mapping with runtimeHostIsLocalMachine absent/false: the lane
    // might be a runtime environment elsewhere, so a desktop file at the same
    // path must not stand in for the runtime's file.
    await expect(
      readRuntimeFilePreview(
        environmentContext({ runtimeHostIsLocalMachine: false }),
        'C:\\Users\\me\\AppData\\Roaming\\orca\\codex-runtime-home\\image.png',
        CHAT_IMAGE_ACCESS
      )
    ).rejects.toThrow('Remote file is outside the owning runtime worktree')

    expect(fsReadFile).not.toHaveBeenCalled()
  })
})
