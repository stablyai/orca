import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type { Worktree } from '../../../shared/worktree/types'
import { createWebFileMutationMethods } from './web-file-mutation-methods'

function resolvedFile(
  id: string,
  hostId: Worktree['hostId'],
  relativePath: string
): { worktree: Pick<Worktree, 'id' | 'hostId'>; relativePath: string } {
  return { worktree: { id, hostId }, relativePath }
}

function connectedSshState(targetId: string, connectionGeneration: number): SshConnectionState {
  return {
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    connectionGeneration
  }
}

describe('paired web file mutation methods', () => {
  const assertMutationSupported = vi.fn(async (): Promise<readonly string[]> => [])
  const callRuntimeResult = vi.fn(async () => ({ ok: true }))
  const getSshState = vi.fn(async () => connectedSshState('hub-private-target', 17))
  const filesByPath = new Map([
    ['/hub/repo/readme.md', resolvedFile('wt-local', 'local', 'readme.md')],
    ['/hub/repo/new.md', resolvedFile('wt-local', 'local', 'new.md')],
    ['/hub/repo/copy.md', resolvedFile('wt-local', 'local', 'copy.md')],
    ['/hub/repo/new-dir', resolvedFile('wt-local', 'local', 'new-dir')],
    ['/ssh/repo/source.md', resolvedFile('wt-ssh', 'ssh:hub-private-target', 'source.md')],
    ['/ssh/repo/renamed.md', resolvedFile('wt-ssh', 'ssh:hub-private-target', 'renamed.md')],
    ['/ssh/repo/copy.md', resolvedFile('wt-ssh', 'ssh:hub-private-target', 'copy.md')],
    ['/ssh/repo/dir', resolvedFile('wt-ssh', 'ssh:hub-private-target', 'dir')]
  ])
  const resolveFilePath = vi.fn(async (filePath: string) => {
    const file = filesByPath.get(filePath)
    if (!file) {
      throw new Error(`Unknown test path: ${filePath}`)
    }
    return file
  })
  const captureSession = vi.fn(() => ({
    assertMutationSupported,
    callRuntimeResult,
    getSshState,
    resolveFilePath
  }))

  beforeEach(() => {
    assertMutationSupported.mockClear()
    callRuntimeResult.mockClear()
    getSshState.mockClear()
    resolveFilePath.mockClear()
    captureSession.mockClear()
  })

  it('keeps path resolution, capability, and mutation on one captured pairing session', async () => {
    const replacementCall = vi.fn(async () => ({ ok: true }))
    const replacementSession = {
      assertMutationSupported: vi.fn(async (): Promise<readonly string[]> => []),
      callRuntimeResult: replacementCall,
      getSshState,
      resolveFilePath
    }
    const capturedSession = {
      assertMutationSupported: vi.fn(async (): Promise<readonly string[]> => {
        captureSession.mockReturnValue(replacementSession)
        return []
      }),
      callRuntimeResult,
      getSshState,
      resolveFilePath
    }
    captureSession.mockReturnValueOnce(capturedSession)
    const methods = createWebFileMutationMethods({ captureSession })

    await methods.writeFile({ filePath: '/hub/repo/readme.md', content: 'bound' })

    expect(captureSession).toHaveBeenCalledTimes(1)
    expect(callRuntimeResult).toHaveBeenCalledWith('files.write', {
      worktree: 'id:wt-local',
      relativePath: 'readme.md',
      content: 'bound',
      expectedExecutionHostId: 'local'
    })
    expect(replacementCall).not.toHaveBeenCalled()
  })
})
