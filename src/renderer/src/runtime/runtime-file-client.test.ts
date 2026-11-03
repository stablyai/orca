import { describe, expect, it } from 'vitest'
import { readRuntimeDirectory } from './runtime-file-mutation-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { readRuntimeFileContent, readRuntimeFilePreview } from './runtime-file-read-client'
import {
  fsReadDir,
  fsReadFile,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client', () => {
  it('declares user-directory access for a local directory listing', async () => {
    fsReadDir.mockResolvedValue([])

    await readRuntimeDirectory(
      {
        target: { kind: 'local' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      '/tmp/reference',
      { access: { kind: 'user-directory' } }
    )

    expect(fsReadDir).toHaveBeenCalledWith({
      dirPath: '/tmp/reference',
      access: { kind: 'user-directory' }
    })
  })

  it('never forwards user-directory access to an SSH directory listing', async () => {
    fsReadDir.mockResolvedValue([])

    await readRuntimeDirectory(
      {
        target: { kind: 'local' },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: 'ssh-1'
      },
      '/repo',
      { access: { kind: 'user-directory' } }
    )

    expect(fsReadDir).toHaveBeenCalledWith({
      dirPath: '/repo',
      connectionId: 'ssh-1'
    })
  })

  it.each([
    '/session/images/chart.png',
    '/remote/repo/chart.png',
    '/srv/orca/agent-session-attachments/abc/u1/shot.png'
  ])('pins a resolved image read to its original pairing: %s', async (path) => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 8 }])
    runtimeEnvironmentCall.mockRejectedValueOnce(new Error('pairing changed'))
    await expect(
      readRuntimeFilePreview(
        {
          target: { kind: 'environment', environmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo',
          expectedEnvironmentPairingRevision: 7
        },
        path,
        { kind: 'chat-image' }
      )
    ).rejects.toThrow('pairing changed')
    expect(runtimeEnvironmentCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedEnvironmentPairingRevision: 7 })
    )
    expect(fsReadFile).not.toHaveBeenCalled()
  })
  it('shows an unlisted binary an older host sent as text as binary, fetching nothing more', async () => {
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        args.method === 'files.read'
          ? {
              id: 'rpc-read',
              ok: true,
              result: { content: '\u007fELF\u0002\u0000\u0001', truncated: true, byteLength: 7 },
              _meta: { runtimeId: 'remote-runtime' }
            }
          : { id: 'rpc-other', ok: false, error: { code: 'runtime_error', message: 'unexpected' } }
      )
    )

    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        filePath: '/remote/repo/libfoo.so',
        relativePath: 'libfoo.so',
        worktreeId: 'wt-1'
      })
    ).resolves.toEqual({ content: '', isBinary: true })
    // Nothing more is fetched: not paged in chunks though truncated, and no preview to show.
    for (const method of ['files.readChunk', 'files.readPreview']) {
      expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(expect.objectContaining({ method }))
    }
  })

  describe('remote audio and video', () => {
    it('opens an SVG as editable markup even when a viewer asks for a URL', async () => {
      const markup = '<svg viewBox="0 0 10 10"><title>café</title></svg>'
      fsReadFile.mockResolvedValue({
        content: Buffer.from(markup).toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType: 'image/svg+xml'
      })
      await expect(
        readRuntimeFileContent({
          target: { kind: 'local' as const },
          filePath: '/repo/logo.svg',
          relativePath: 'logo.svg',
          worktreeId: 'wt-1',
          pageOversizedBinary: true
        })
      ).resolves.toEqual({ content: markup, isBinary: false })
      expect(fsReadFile).toHaveBeenCalledWith(expect.not.objectContaining({ rangePreview: true }))
    })
  })
})
