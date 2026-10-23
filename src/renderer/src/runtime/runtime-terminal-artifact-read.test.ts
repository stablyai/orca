import { describe, expect, it } from 'vitest'
import { readRuntimeFileContent, readRuntimeFilePreview } from './runtime-file-read-client'
import {
  fsReadFile,
  runtimeEnvironmentCall,
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

describe('a chat image outside every workspace on a paired host', () => {
  const chatImage = {
    target: { kind: 'environment' as const, environmentId: 'env-1' },
    worktreeId: 'wt-1',
    worktreePath: '/srv/repo',
    nativeChatContext: { tabId: 'tab-1', sessionId: 'session-1' }
  }

  function answer(method: string, result: unknown) {
    return { id: method, ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
  }

  it('asks the host for a grant, then previews through it', async () => {
    const preview = { content: 'iVBO', isBinary: true, isImage: true, mimeType: 'image/png' }
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        args.method === 'files.resolveTerminalPath'
          ? answer(args.method, {
              worktree: 'wt-1',
              relativePath: null,
              absolutePath: '/mnt/data/report.png',
              exists: true,
              isDirectory: false,
              openTarget: {
                kind: 'absolute-file',
                provider: 'local',
                absolutePath: '/mnt/data/report.png',
                grantId: 'g-chat',
                readOnly: true
              }
            })
          : answer(args.method, preview)
      )
    )

    await expect(readRuntimeFilePreview(chatImage, '/mnt/data/report.png')).resolves.toEqual(
      preview
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.resolveTerminalPath',
        params: {
          worktree: 'id:wt-1',
          pathText: '/mnt/data/report.png',
          nativeChatContext: { tabId: 'tab-1', sessionId: 'session-1' }
        }
      })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.readTerminalArtifactPreview',
        params: { worktree: 'id:wt-1', grantId: 'g-chat', absolutePath: '/mnt/data/report.png' }
      })
    )
  })

  it('fails on the host instead of reading this computer when the host has no such file', async () => {
    runtimeEnvironmentCall.mockResolvedValue(
      answer('files.resolveTerminalPath', {
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/mnt/data/missing.png',
        exists: false,
        isDirectory: false
      })
    )

    await expect(readRuntimeFilePreview(chatImage, '/mnt/data/missing.png')).rejects.toThrow(
      'File not found on its host: /mnt/data/missing.png'
    )
    expect(fsReadFile).not.toHaveBeenCalled()
  })
})
