import { describe, expect, it } from 'vitest'
import { readRuntimeDirectory } from './runtime-file-mutation-client'
import { readRuntimeFileContent, readRuntimeFilePreview } from './runtime-file-read-client'
import {
  fsReadFile,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client', () => {
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
