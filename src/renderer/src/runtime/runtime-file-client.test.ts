import { describe, expect, it } from 'vitest'
import {
  deleteRuntimePath,
  readRuntimeDirectory,
  renameRuntimePath,
  writeRuntimeFile
} from './runtime-file-mutation-client'
import { getRuntimeFileReadScope } from './runtime-file-routing'
import { readRuntimeFileContent, readRuntimeFilePreview } from './runtime-file-read-client'
import type { RuntimeReadableFileContent } from './runtime-file-client-types'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import {
  fsReadDir,
  fsReadFile,
  fsStat,
  fsWriteFile,
  fsRename,
  fsDeletePath,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client', () => {
  it('sends the confirmed permanent-delete option only to the local filesystem', async () => {
    await deleteRuntimePath(
      { target: { kind: 'local' }, worktreeId: 'wt-1', worktreePath: '/repo' },
      '/repo/file.txt',
      false,
      { permanent: true }
    )
    expect(fsDeletePath).toHaveBeenCalledWith({
      targetPath: '/repo/file.txt',
      connectionId: undefined,
      expectedExecutionHostId: 'local',
      recursive: false,
      permanent: true
    })

    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
    await deleteRuntimePath(
      {
        target: { kind: 'environment', environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      '/remote/repo/file.txt',
      false,
      { permanent: true }
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.delete',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'file.txt',
        recursive: false,
        expectedExecutionHostId: 'local'
      },
      timeoutMs: 15_000
    })
    expect(fsDeletePath).toHaveBeenCalledTimes(1)
  })

  it('uses local filesystem reads when no remote runtime is active', async () => {
    const localResult: RuntimeReadableFileContent = { content: 'hello', isBinary: false }
    fsReadFile.mockResolvedValue(localResult)

    await expect(
      readRuntimeFileContent({
        target: { kind: 'local' as const },
        filePath: '/repo/readme.md',
        relativePath: 'readme.md',
        worktreeId: 'wt-1',
        connectionId: 'ssh-1'
      })
    ).resolves.toBe(localResult)

    expect(fsReadFile).toHaveBeenCalledWith({ filePath: '/repo/readme.md', connectionId: 'ssh-1' })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('reads an external SSH file only from its owning target', async () => {
    const sshResult: RuntimeReadableFileContent = { content: 'remote', isBinary: false }
    fsReadFile.mockResolvedValue(sshResult)

    await expect(
      readRuntimeFileContent({
        target: { kind: 'local' as const },
        filePath: '/tmp/external.md',
        relativePath: '/tmp/external.md',
        worktreeId: 'wt-1',
        connectionId: 'ssh-1',
        expectedExternalSshTargetId: 'ssh-1'
      })
    ).resolves.toBe(sshResult)

    expect(fsReadFile).toHaveBeenCalledWith({
      filePath: '/tmp/external.md',
      connectionId: 'ssh-1',
      includeLocalLogMetadata: undefined
    })
  })

  it('rejects an external SSH file read after the target changes', async () => {
    await expect(
      readRuntimeFileContent({
        target: { kind: 'local' as const },
        filePath: '/tmp/external.md',
        relativePath: '/tmp/external.md',
        worktreeId: 'wt-1',
        connectionId: 'ssh-2',
        expectedExternalSshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('External SSH files are not available after the workspace host changes.')

    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('rejects an external SSH file read through a runtime environment', async () => {
    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        filePath: '/tmp/external.md',
        relativePath: '/tmp/external.md',
        worktreeId: 'wt-1',
        connectionId: 'ssh-1',
        expectedExternalSshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('External SSH files are not available after the workspace host changes.')

    expect(fsReadFile).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('binds direct SSH mutations to the captured target and generation', async () => {
    const context = {
      target: { kind: 'local' as const },
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      expectedExecutionHostId: 'ssh:ssh-1' as const,
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 5
    }

    await writeRuntimeFile(context, '/repo/a.ts', 'a')
    await renameRuntimePath(context, '/repo/a.ts', '/repo/b.ts')
    await deleteRuntimePath(context, '/repo/b.ts')

    expect(fsWriteFile).toHaveBeenCalledWith({
      filePath: '/repo/a.ts',
      content: 'a',
      connectionId: 'ssh-1',
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 5
    })
    expect(fsRename).toHaveBeenCalledWith({
      oldPath: '/repo/a.ts',
      newPath: '/repo/b.ts',
      connectionId: 'ssh-1',
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 5
    })
    expect(fsDeletePath).toHaveBeenCalledWith({
      targetPath: '/repo/b.ts',
      connectionId: 'ssh-1',
      expectedExecutionHostId: 'ssh:ssh-1',
      recursive: undefined,
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 5
    })
  })

  it('routes worktree-relative text reads through the selected runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        worktree: 'id:wt-1',
        relativePath: 'src/index.ts',
        content: 'export {}\n',
        truncated: false,
        byteLength: 10
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        filePath: '/remote/repo/src/index.ts',
        relativePath: 'src/index.ts',
        worktreeId: 'wt-1'
      })
    ).resolves.toEqual({ content: 'export {}\n', isBinary: false })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.read',
      params: { worktree: 'id:wt-1', relativePath: 'src/index.ts' },
      timeoutMs: 15_000
    })
    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('keeps external absolute-path files on the local filesystem path', async () => {
    const localResult: RuntimeReadableFileContent = { content: 'scratch', isBinary: false }
    fsReadFile.mockResolvedValue(localResult)

    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        filePath: '/Users/me/scratch.md',
        relativePath: '/Users/me/scratch.md'
      })
    ).resolves.toBe(localResult)

    expect(fsReadFile).toHaveBeenCalledWith({
      filePath: '/Users/me/scratch.md',
      connectionId: undefined
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  // Why: a restored host-file tab lost its grant; only its host may answer for the path.
  it('asks the host for a grant for an absolute host path, never this computer', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/scratch.md',
        exists: false,
        isDirectory: false
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        filePath: '/tmp/scratch.md',
        relativePath: '/tmp/scratch.md',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.resolveTerminalPath' })
    )
    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('rejects remote-owned text reads that are not worktree-relative', async () => {
    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        filePath: '/remote/repo/unknown.md',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('Remote file is outside the owning runtime worktree')
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('rejects truncated remote reads instead of returning partial editable content', async () => {
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        args.method === 'files.read'
          ? {
              id: 'rpc-1',
              ok: true,
              result: {
                worktree: 'id:wt-1',
                relativePath: 'large.log',
                content: 'partial',
                truncated: true,
                byteLength: 524_288
              },
              _meta: { runtimeId: 'remote-runtime' }
            }
          : {
              id: 'rpc-2',
              ok: false,
              error: { code: 'method_not_found', message: `Unknown method: ${args.method}` },
              _meta: { runtimeId: 'remote-runtime' }
            }
      )
    )

    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        filePath: '/remote/repo/large.log',
        relativePath: 'large.log',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('Update the server to open it')
  })

  it('falls back to files.readPreview when a remote binary file is opened', async () => {
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'files.read') {
        return Promise.resolve({
          id: 'rpc-read',
          ok: false,
          error: { code: 'runtime_error', message: 'binary_file' },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: 'rpc-preview',
        ok: true,
        result: {
          content: 'JVBERi0=',
          isBinary: true,
          isImage: true,
          mimeType: 'application/pdf'
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        filePath: '/remote/repo/doc.pdf',
        relativePath: 'doc.pdf',
        worktreeId: 'wt-1'
      })
    ).resolves.toEqual({
      content: 'JVBERi0=',
      isBinary: true,
      isImage: true,
      mimeType: 'application/pdf'
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.read',
      params: { worktree: 'id:wt-1', relativePath: 'doc.pdf' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readPreview',
      params: { worktree: 'id:wt-1', relativePath: 'doc.pdf' },
      timeoutMs: 15_000
    })
  })

  it('does not fall back to files.readPreview for non-binary remote read errors', async () => {
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'files.read') {
        return Promise.resolve({
          id: 'rpc-read',
          ok: false,
          error: { code: 'runtime_error', message: 'permission_denied' },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      throw new Error('files.readPreview should not be called')
    })

    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        filePath: '/remote/repo/secret.txt',
        relativePath: 'secret.txt',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('permission_denied')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.readPreview' })
    )
  })

  it('propagates a files.readPreview failure during the binary fallback', async () => {
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'files.read') {
        return Promise.resolve({
          id: 'rpc-read',
          ok: false,
          error: { code: 'runtime_error', message: 'binary_file' },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: 'rpc-preview',
        ok: false,
        error: { code: 'runtime_error', message: 'file_too_large' },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        filePath: '/remote/repo/huge.pdf',
        relativePath: 'huge.pdf',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('file_too_large')

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.readPreview' })
    )
  })

  it('does not fall back when a non-RPC error merely shares the binary_file message', async () => {
    // Only typed RuntimeRpcCallError(binary_file) authorizes preview fallback; matching transport-error text must propagate.
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'files.read') {
        return Promise.reject(new Error('binary_file'))
      }
      throw new Error('files.readPreview should not be called')
    })

    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        filePath: '/remote/repo/doc.pdf',
        relativePath: 'doc.pdf',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('binary_file')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.readPreview' })
    )
  })

  it('uses the owner runtime id as the dedupe scope', () => {
    expect(getRuntimeFileReadScope({ kind: 'environment', environmentId: 'env-1' }, 'ssh-1')).toBe(
      'runtime:env-1'
    )
    expect(getRuntimeFileReadScope({ kind: 'local' }, 'ssh-1')).toBe('ssh-1')
  })

  it('routes directory reads through the selected runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: [{ name: 'src', isDirectory: true }],
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      readRuntimeDirectory(
        {
          target: { kind: 'environment' as const, environmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/src'
      )
    ).resolves.toEqual([{ name: 'src', isDirectory: true }])

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readDir',
      params: { worktree: 'id:wt-1', relativePath: 'src' },
      timeoutMs: 15_000
    })
  })

  it('routes Windows drive paths case-insensitively through the selected runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: [],
      _meta: { runtimeId: 'remote-runtime' }
    })

    await readRuntimeDirectory(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: 'C:\\Repo'
      },
      'c:\\repo\\Src'
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readDir',
      params: { worktree: 'id:wt-1', relativePath: 'Src' },
      timeoutMs: 15_000
    })
  })

  it('sends the WSL wake flag of a user act to the local read only, never to a remote host', async () => {
    fsReadDir.mockResolvedValue([])
    await readRuntimeDirectory(
      { target: { kind: 'local' as const }, worktreeId: 'wt-1', worktreePath: 'C:\\Repo' },
      'C:\\Repo',
      { followSymlinks: true, wakeWslDistro: true }
    )
    expect(fsReadDir).toHaveBeenCalledWith({
      dirPath: 'C:\\Repo',
      connectionId: undefined,
      followSymlinks: true,
      wakeWslDistro: true
    })

    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: [],
      _meta: { runtimeId: 'remote-runtime' }
    })
    await readRuntimeDirectory(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      '/repo/src',
      { wakeWslDistro: true }
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readDir',
      params: { worktree: 'id:wt-1', relativePath: 'src' },
      timeoutMs: 15_000
    })
  })

  it('sends the WSL wake flag of a user act with a local file read, never over SSH', async () => {
    fsReadFile.mockResolvedValue({ content: 'x', isBinary: false })
    await readRuntimeFileContent({
      target: { kind: 'local' as const },
      filePath: 'C:\\Repo\\a.ts',
      wakeWslDistro: true
    })
    expect(fsReadFile).toHaveBeenLastCalledWith(expect.objectContaining({ wakeWslDistro: true }))
    await readRuntimeFileContent({
      target: { kind: 'local' as const },
      filePath: '/remote/a.ts',
      connectionId: 'ssh-1',
      wakeWslDistro: true
    })
    expect(fsReadFile).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ wakeWslDistro: true })
    )
  })

  it('stats a user-opened path as a user act that may start a stopped WSL distro', async () => {
    fsStat.mockResolvedValue({ size: 1, isDirectory: false, mtime: 0 })
    await statUserOpenedPath(
      { target: { kind: 'local' as const }, worktreeId: 'wt-1', worktreePath: 'C:\\Repo' },
      'C:\\Repo\\a.ts'
    )
    expect(fsStat).toHaveBeenLastCalledWith(expect.objectContaining({ wakeWslDistro: true }))
  })

  it('routes forward-slash UNC paths through the selected runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: [],
      _meta: { runtimeId: 'remote-runtime' }
    })

    await readRuntimeDirectory(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '//Server/Share/Repo'
      },
      '//server/share/repo/src'
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readDir',
      params: { worktree: 'id:wt-1', relativePath: 'src' },
      timeoutMs: 15_000
    })
  })

  it('routes preview reads through the selected runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { content: 'base64', isBinary: true, isImage: true, mimeType: 'image/png' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      readRuntimeFilePreview(
        {
          target: { kind: 'environment' as const, environmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/images/logo.png'
      )
    ).resolves.toEqual({
      content: 'base64',
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readPreview',
      params: { worktree: 'id:wt-1', relativePath: 'images/logo.png' },
      timeoutMs: 15_000
    })
  })

  it('rejects an external SSH image preview after the target changes', async () => {
    await expect(
      readRuntimeFilePreview(
        {
          target: { kind: 'local' as const },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo',
          connectionId: 'ssh-2',
          expectedExternalSshTargetId: 'ssh-1'
        },
        '/tmp/logo.png'
      )
    ).rejects.toThrow('External SSH files are not available after the workspace host changes.')

    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('does not fall back to client-local preview reads for remote-owned files outside the worktree', async () => {
    await expect(
      readRuntimeFilePreview(
        {
          target: { kind: 'environment' as const, environmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/tmp/logo.png'
      )
    ).rejects.toThrow('outside the owning runtime worktree')

    expect(fsReadFile).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  // A chat attachment lives in the paired server's store, outside every worktree.
  it.each([
    { worktreeId: 'wt-1', worktreePath: '/remote/repo' },
    { worktreeId: null, worktreePath: null }
  ])('reads a stored chat attachment back through its server ($worktreeId)', async (owner) => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { content: 'base64', isBinary: true, isImage: true, mimeType: 'image/png' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const storedPath = '/srv/orca/agent-session-attachments/abc/u1/shot.png'

    await expect(
      readRuntimeFilePreview(
        { target: { kind: 'environment' as const, environmentId: 'env-1' }, ...owner },
        storedPath
      )
    ).resolves.toMatchObject({ content: 'base64', mimeType: 'image/png' })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'agentSessionAttachment.read',
      params: { path: storedPath },
      timeoutMs: 15_000
    })
    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('routes root directory reads with an empty relative path', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: [],
      _meta: { runtimeId: 'remote-runtime' }
    })

    await readRuntimeDirectory(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      '/remote/repo'
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readDir',
      params: { worktree: 'id:wt-1', relativePath: '' },
      timeoutMs: 15_000
    })
  })

  it('does not fall back to client-local directory reads for remote-owned paths outside the worktree', async () => {
    await expect(
      readRuntimeDirectory(
        {
          target: { kind: 'environment' as const, environmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo',
          connectionId: 'ssh-1'
        },
        '/tmp'
      )
    ).rejects.toThrow('outside the owning runtime worktree')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
