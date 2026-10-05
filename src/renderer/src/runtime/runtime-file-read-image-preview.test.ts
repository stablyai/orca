import { describe, expect, it } from 'vitest'
import { readRuntimeFileContent } from './runtime-file-read-client'
import {
  fsReadFile,
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

const settings = { activeRuntimeEnvironmentId: 'env-1' }
const preview = {
  content: 'PHN2Zy8+',
  isBinary: true,
  isImage: true,
  mimeType: 'image/svg+xml'
}

function read(relativePath: string): ReturnType<typeof readRuntimeFileContent> {
  return readRuntimeFileContent({
    settings,
    filePath: `/remote/repo/${relativePath}`,
    relativePath,
    worktreeId: 'wt-1'
  })
}

describe('remote desktop image preview routing', () => {
  it.each(['diagram.svg', 'images/DIAGRAM.SVG', 'images\\diagram.svg', 'diagram.svg.svg'])(
    'opens %s through the existing image preview RPC',
    async (relativePath) => {
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'preview',
        ok: true,
        result: preview,
        _meta: { runtimeId: 'remote-runtime' }
      })
      await expect(read(relativePath)).resolves.toEqual(preview)
      expect(runtimeEnvironmentCall).toHaveBeenCalledExactlyOnceWith({
        selector: 'env-1',
        expectedEnvironmentPairingRevision: undefined,
        expectedEnvironmentRuntimeId: undefined,
        method: 'files.readPreview',
        params: { worktree: 'id:wt-1', relativePath },
        timeoutMs: 15_000
      })
      expect(fsReadFile).not.toHaveBeenCalled()
    }
  )

  it.each(['image.png', 'image.JPEG', 'image.gif', 'image.webp', 'image.bmp', 'image.ico'])(
    'uses the same preview path for %s',
    async (relativePath) => {
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'preview',
        ok: true,
        result: preview,
        _meta: { runtimeId: 'remote-runtime' }
      })
      await read(relativePath)
      expect(runtimeEnvironmentCall.mock.calls[0]?.[0].method).toBe('files.readPreview')
    }
  )

  it.each(['.svg', 'images.svg/notes.md', 'diagram.svg.txt', 'notes.md'])(
    'keeps %s on the text read path',
    async (relativePath) => {
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'text',
        ok: true,
        result: { content: 'text', truncated: false, byteLength: 4 },
        _meta: { runtimeId: 'remote-runtime' }
      })
      await expect(read(relativePath)).resolves.toEqual({ content: 'text', isBinary: false })
      expect(runtimeEnvironmentCall.mock.calls[0]?.[0].method).toBe('files.read')
    }
  )

  it('does not fall back to a local file after remote preview permission failure', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'denied',
      ok: false,
      error: { code: 'forbidden', message: 'access denied' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    await expect(read('diagram.svg')).rejects.toThrow('access denied')
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('keeps local and direct SSH image reads on their existing preload path', async () => {
    fsReadFile.mockResolvedValue(preview)
    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: null },
        filePath: '/repo/diagram.svg',
        relativePath: 'diagram.svg',
        worktreeId: 'wt-1',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual(preview)
    expect(fsReadFile).toHaveBeenCalledWith({
      filePath: '/repo/diagram.svg',
      connectionId: 'ssh-1',
      includeLocalLogMetadata: undefined
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
