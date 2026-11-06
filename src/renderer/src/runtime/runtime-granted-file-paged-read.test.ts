import { describe, expect, it } from 'vitest'
import { readRuntimeFileContent } from './runtime-file-read-client'
import {
  runtimeEnvironmentCall,
  fsGrantRuntimeFilePreview,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

const granted = {
  target: { kind: 'environment' as const, environmentId: 'env-1' },
  worktreeId: 'wt-1',
  terminalArtifactGrantId: 'g-1'
}

function chunkRangeOf(params: unknown): { offset: number; length: number } {
  return typeof params === 'object' && params !== null && 'offset' in params && 'length' in params
    ? { offset: Number(params.offset), length: Number(params.length) }
    : { offset: 0, length: 0 }
}

describe('a granted host file outside every workspace', () => {
  // Why: one reply caps at 512 KiB, so a granted file pages through its grant like a workspace file.
  it('streams a granted video to its viewer and pages granted text past one reply', async () => {
    const video = { ...granted, filePath: '/tmp/clip.mp4', relativePath: '/tmp/clip.mp4' }
    const mediaUrl = {
      content: '',
      isBinary: true,
      mimeType: 'video/mp4',
      mediaUrl: 'orca-media://file/t'
    }
    fsGrantRuntimeFilePreview.mockResolvedValue(mediaUrl)

    await expect(readRuntimeFileContent({ ...video, pageOversizedBinary: true })).resolves.toEqual(
      mediaUrl
    )
    expect(fsGrantRuntimeFilePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'env-1',
        worktree: 'id:wt-1',
        grantId: 'g-1',
        absolutePath: '/tmp/clip.mp4'
      })
    )

    const text = { ...granted, filePath: '/tmp/big.log', relativePath: '/tmp/big.log' }
    const bytes = new TextEncoder().encode('x'.repeat(600 * 1024))
    const meta = { runtimeId: 'remote-runtime' }
    runtimeEnvironmentCall.mockImplementation(
      async (args: { method: string; params?: unknown }) => {
        switch (args.method) {
          case 'files.readTerminalArtifact':
            return {
              id: 'rpc',
              ok: false,
              error: { code: 'runtime_error', message: 'file_too_large' },
              _meta: meta
            }
          case 'files.statTerminalArtifact':
            return {
              id: 'rpc',
              ok: true,
              result: { size: bytes.length, isDirectory: false, mtime: 1, ctime: 1 },
              _meta: meta
            }
          case 'files.readTerminalArtifactChunk': {
            const { offset, length } = chunkRangeOf(args.params)
            const page = bytes.subarray(offset, offset + length)
            return {
              id: 'rpc',
              ok: true,
              result: {
                contentBase64: Buffer.from(page).toString('base64'),
                bytesRead: page.length,
                eof: offset + page.length >= bytes.length
              },
              _meta: meta
            }
          }
          default:
            throw new Error(`unexpected ${args.method}`)
        }
      }
    )

    const read = await readRuntimeFileContent(text)
    expect(read.content.length).toBe(bytes.length)
    expect(read.isBinary).toBe(false)
  })
})
