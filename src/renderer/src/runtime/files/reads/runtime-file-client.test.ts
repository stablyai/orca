import { describe, expect, it } from 'vitest'
import { readRuntimeFileContent } from './runtime-file-read-client'
import {
  fsReadFile,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment
} from '../runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client', () => {
  it('classifies an unlisted binary an older host sent as text', async () => {
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
    })
  })
})
