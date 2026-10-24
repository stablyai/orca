import { describe, expect, it } from 'vitest'
import { readRuntimeFileContent } from './runtime-file-read-client'
import {
  runtimeEnvironmentCall,
  runtimeCall,
  fsReadFile,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

const granted = {
  target: { kind: 'environment' as const, environmentId: 'env-1' },
  filePath: '/tmp/out.png',
  relativePath: '/tmp/out.png',
  worktreeId: 'wt-1',
  terminalArtifactGrantId: 'g-1'
}
const grantParams = { worktree: 'id:wt-1', grantId: 'g-1', absolutePath: '/tmp/out.png' }

describe('a granted host file outside every workspace', () => {
  it('reads a local grant through the runtime instead of an ungranted filesystem read', async () => {
    runtimeCall.mockResolvedValue({
      id: 'local-1',
      ok: true,
      result: {
        worktree: 'wt-1',
        relativePath: '/tmp/out.png',
        content: 'local log',
        truncated: false,
        byteLength: 9
      }
    })
    await expect(
      readRuntimeFileContent({ ...granted, target: { kind: 'local' } })
    ).resolves.toEqual({ content: 'local log', isBinary: false })
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'files.readTerminalArtifact',
      params: grantParams
    })
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
  it('previews a local binary grant without using the ordinary filesystem reader', async () => {
    const preview = { content: 'iVBO', isBinary: true, isImage: true, mimeType: 'image/png' }
    runtimeCall.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        args.method === 'files.readTerminalArtifact'
          ? { id: 'local-1', ok: false, error: { code: 'runtime_error', message: 'binary_file' } }
          : { id: 'local-2', ok: true, result: preview }
      )
    )
    await expect(
      readRuntimeFileContent({ ...granted, target: { kind: 'local' } })
    ).resolves.toEqual(preview)
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'files.readTerminalArtifactPreview',
      params: grantParams
    })
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
  it('refuses a grant without its owning workspace instead of reading this computer', async () => {
    await expect(
      readRuntimeFileContent({ ...granted, target: { kind: 'local' }, worktreeId: undefined })
    ).rejects.toThrow('owning workspace')
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('reads text through its grant', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        worktree: 'wt-1',
        relativePath: '/tmp/out.png',
        content: 'log',
        truncated: false,
        byteLength: 3
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(readRuntimeFileContent(granted)).resolves.toEqual({
      content: 'log',
      isBinary: false
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.readTerminalArtifact', params: grantParams })
    )
  })

  it('previews a binary file through its grant', async () => {
    const preview = { content: 'iVBO', isBinary: true, isImage: true, mimeType: 'image/png' }
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        args.method === 'files.readTerminalArtifact'
          ? {
              id: 'rpc-1',
              ok: false,
              error: { code: 'runtime_error', message: 'binary_file' },
              _meta: { runtimeId: 'remote-runtime' }
            }
          : { id: 'rpc-2', ok: true, result: preview, _meta: { runtimeId: 'remote-runtime' } }
      )
    )

    await expect(readRuntimeFileContent(granted)).resolves.toEqual(preview)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.readTerminalArtifactPreview', params: grantParams })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.read' })
    )
  })
})
