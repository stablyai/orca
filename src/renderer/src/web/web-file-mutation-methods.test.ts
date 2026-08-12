import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type { Worktree } from '../../../shared/types'
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
  const assertMutationSupported = vi.fn(async () => {})
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

  it('binds every HUB-local mutation to the local execution host', async () => {
    const methods = createWebFileMutationMethods({ captureSession })

    await methods.writeFile({ filePath: '/hub/repo/readme.md', content: 'updated' })
    await methods.createFile({ filePath: '/hub/repo/new.md' })
    await methods.createDir({ dirPath: '/hub/repo/new-dir' })
    await methods.rename({ oldPath: '/hub/repo/readme.md', newPath: '/hub/repo/new.md' })
    await methods.copy({
      sourcePath: '/hub/repo/new.md',
      destinationPath: '/hub/repo/copy.md'
    })
    await methods.deletePath({ targetPath: '/hub/repo/new-dir', recursive: true })

    expect(callRuntimeResult.mock.calls).toEqual([
      [
        'files.write',
        {
          worktree: 'id:wt-local',
          relativePath: 'readme.md',
          content: 'updated',
          expectedExecutionHostId: 'local'
        }
      ],
      [
        'files.createFile',
        {
          worktree: 'id:wt-local',
          relativePath: 'new.md',
          expectedExecutionHostId: 'local'
        }
      ],
      [
        'files.createDir',
        {
          worktree: 'id:wt-local',
          relativePath: 'new-dir',
          expectedExecutionHostId: 'local'
        }
      ],
      [
        'files.rename',
        {
          worktree: 'id:wt-local',
          oldRelativePath: 'readme.md',
          newRelativePath: 'new.md',
          expectedExecutionHostId: 'local'
        }
      ],
      [
        'files.copy',
        {
          worktree: 'id:wt-local',
          sourceRelativePath: 'new.md',
          destinationRelativePath: 'copy.md',
          expectedExecutionHostId: 'local'
        }
      ],
      [
        'files.delete',
        {
          worktree: 'id:wt-local',
          relativePath: 'new-dir',
          recursive: true,
          expectedExecutionHostId: 'local'
        }
      ]
    ])
    expect(getSshState).not.toHaveBeenCalled()
  })

  it('binds every nested SSH mutation to the HUB-owned session generation', async () => {
    const methods = createWebFileMutationMethods({ captureSession })

    await methods.writeFile({ filePath: '/ssh/repo/source.md', content: 'updated' })
    await methods.createFile({ filePath: '/ssh/repo/copy.md' })
    await methods.createDir({ dirPath: '/ssh/repo/dir' })
    await methods.rename({
      oldPath: '/ssh/repo/source.md',
      newPath: '/ssh/repo/renamed.md'
    })
    await methods.copy({
      sourcePath: '/ssh/repo/renamed.md',
      destinationPath: '/ssh/repo/copy.md'
    })
    await methods.deletePath({ targetPath: '/ssh/repo/dir', recursive: true })

    expect(callRuntimeResult.mock.calls).toEqual([
      [
        'files.write',
        {
          worktree: 'id:wt-ssh',
          relativePath: 'source.md',
          content: 'updated',
          expectedExecutionHostId: 'ssh:hub-private-target',
          expectedSshTargetId: 'hub-private-target',
          expectedSshConnectionGeneration: 17
        }
      ],
      [
        'files.createFile',
        {
          worktree: 'id:wt-ssh',
          relativePath: 'copy.md',
          expectedExecutionHostId: 'ssh:hub-private-target',
          expectedSshTargetId: 'hub-private-target',
          expectedSshConnectionGeneration: 17
        }
      ],
      [
        'files.createDir',
        {
          worktree: 'id:wt-ssh',
          relativePath: 'dir',
          expectedExecutionHostId: 'ssh:hub-private-target',
          expectedSshTargetId: 'hub-private-target',
          expectedSshConnectionGeneration: 17
        }
      ],
      [
        'files.rename',
        {
          worktree: 'id:wt-ssh',
          oldRelativePath: 'source.md',
          newRelativePath: 'renamed.md',
          expectedExecutionHostId: 'ssh:hub-private-target',
          expectedSshTargetId: 'hub-private-target',
          expectedSshConnectionGeneration: 17
        }
      ],
      [
        'files.copy',
        {
          worktree: 'id:wt-ssh',
          sourceRelativePath: 'renamed.md',
          destinationRelativePath: 'copy.md',
          expectedExecutionHostId: 'ssh:hub-private-target',
          expectedSshTargetId: 'hub-private-target',
          expectedSshConnectionGeneration: 17
        }
      ],
      [
        'files.delete',
        {
          worktree: 'id:wt-ssh',
          relativePath: 'dir',
          recursive: true,
          expectedExecutionHostId: 'ssh:hub-private-target',
          expectedSshTargetId: 'hub-private-target',
          expectedSshConnectionGeneration: 17
        }
      ]
    ])
    expect(getSshState).toHaveBeenCalledTimes(6)
    expect(getSshState).toHaveBeenCalledWith('hub-private-target')
  })

  it('fails closed before mutation when the HUB does not publish an SSH generation', async () => {
    getSshState.mockResolvedValueOnce({
      ...connectedSshState('hub-private-target', 17),
      connectionGeneration: undefined
    })
    const methods = createWebFileMutationMethods({ captureSession })

    await expect(
      methods.writeFile({ filePath: '/ssh/repo/source.md', content: 'unsafe' })
    ).rejects.toThrow("Couldn't verify the SSH connection")
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })

  it('fails closed when the worktree publishes an invalid execution host', async () => {
    resolveFilePath.mockResolvedValueOnce(
      resolvedFile('wt-invalid', 'runtime:' as Worktree['hostId'], 'source.md')
    )
    const methods = createWebFileMutationMethods({ captureSession })

    await expect(
      methods.writeFile({ filePath: '/invalid/source.md', content: 'unsafe' })
    ).rejects.toThrow("Couldn't verify the SSH connection")
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })

  it('rejects rename and copy across worktrees before mutation', async () => {
    const methods = createWebFileMutationMethods({ captureSession })

    await expect(
      methods.rename({ oldPath: '/hub/repo/readme.md', newPath: '/ssh/repo/renamed.md' })
    ).rejects.toThrow('cannot cross runtime worktrees')
    await expect(
      methods.copy({
        sourcePath: '/ssh/repo/source.md',
        destinationPath: '/hub/repo/new.md'
      })
    ).rejects.toThrow('cannot cross runtime worktrees')
    expect(getSshState).not.toHaveBeenCalled()
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })

  it('treats the paired runtime transport as HUB-local execution', async () => {
    resolveFilePath.mockResolvedValueOnce(
      resolvedFile('wt-runtime', 'runtime:paired-hub', 'readme.md')
    )
    const methods = createWebFileMutationMethods({ captureSession })

    await methods.writeFile({ filePath: '/runtime/repo/readme.md', content: 'updated' })

    expect(callRuntimeResult).toHaveBeenCalledWith('files.write', {
      worktree: 'id:wt-runtime',
      relativePath: 'readme.md',
      content: 'updated',
      expectedExecutionHostId: 'local'
    })
    expect(getSshState).not.toHaveBeenCalled()
  })

  it('rejects an old HUB before reading SSH state or sending a mutation', async () => {
    assertMutationSupported.mockRejectedValueOnce(new Error('Update the HUB'))
    const methods = createWebFileMutationMethods({ captureSession })

    await expect(
      methods.deletePath({ targetPath: '/ssh/repo/dir', recursive: true })
    ).rejects.toThrow('Update the HUB')
    expect(getSshState).not.toHaveBeenCalled()
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })

  it('keeps path resolution, capability, and mutation on one captured pairing session', async () => {
    const replacementCall = vi.fn(async () => ({ ok: true }))
    const replacementSession = {
      assertMutationSupported: vi.fn(async () => {}),
      callRuntimeResult: replacementCall,
      getSshState,
      resolveFilePath
    }
    const capturedSession = {
      assertMutationSupported: vi.fn(async () => {
        captureSession.mockReturnValue(replacementSession)
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
