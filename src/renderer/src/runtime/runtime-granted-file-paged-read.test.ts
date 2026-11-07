import { describe, expect, it } from 'vitest'
import { readRuntimeFileContent } from './files/reads/runtime-file-read-client'
import { readRuntimeFileBytes } from './files/reads/runtime-paged-file-read'
import {
  runtimeEnvironmentCall,
  fsGrantRuntimeFilePreview,
  installRuntimeFileClientEnvironment
} from './files/runtime-file-client-test-harness'

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

function grantIdOf(params: unknown): unknown {
  return typeof params === 'object' && params !== null && 'grantId' in params
    ? params.grantId
    : undefined
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

    await expect(readRuntimeFileContent({ ...video, pageOversizedBinary: true })).resolves.toEqual({
      ...mediaUrl,
      terminalArtifactGrantId: 'g-1',
      readOnly: true
    })
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
    // Why: a grant saves only within one write, so a larger file must not open editable.
    expect(read.readOnly).toBe(true)
  })

  // Why: a bytes editor pages the file with the grant that served it, not the one that lapsed.
  it('reports the grant it renewed to read a lapsed one', async () => {
    const meta = { runtimeId: 'remote-runtime' }
    runtimeEnvironmentCall.mockImplementation(
      async (args: { method: string; params?: unknown }) => {
        switch (args.method) {
          case 'files.readTerminalArtifact':
            return grantIdOf(args.params) === 'g-1'
              ? {
                  id: 'rpc',
                  ok: false,
                  error: { code: 'runtime_error', message: 'terminal_file_grant_expired' },
                  _meta: meta
                }
              : { id: 'rpc', ok: true, result: { content: 'ok', isBinary: false }, _meta: meta }
          case 'files.resolveTerminalPath':
            return {
              id: 'rpc',
              ok: true,
              result: {
                worktree: 'wt-1',
                relativePath: null,
                absolutePath: '/tmp/notes.txt',
                exists: true,
                isDirectory: false,
                openTarget: {
                  kind: 'absolute-file',
                  provider: 'local',
                  absolutePath: '/tmp/notes.txt',
                  grantId: 'g-2'
                }
              },
              _meta: meta
            }
          default:
            throw new Error(`unexpected ${args.method}`)
        }
      }
    )

    const read = await readRuntimeFileContent({
      ...granted,
      filePath: '/tmp/notes.txt',
      relativePath: '/tmp/notes.txt'
    })

    expect(read).toMatchObject({ content: 'ok', terminalArtifactGrantId: 'g-2' })
    expect(read).not.toHaveProperty('readOnly')
  })

  // Why: a bytes editor opened after its grant expired must renew it, as the content read does.
  it('renews an expired grant before paging a bytes editor', async () => {
    const meta = { runtimeId: 'remote-runtime' }
    const bytes = Uint8Array.from([1, 2, 3])
    runtimeEnvironmentCall.mockImplementation(
      async (args: { method: string; params?: unknown }) => {
        if (args.method === 'files.resolveTerminalPath') {
          return {
            id: 'rpc',
            ok: true,
            result: {
              worktree: 'wt-1',
              relativePath: null,
              absolutePath: '/tmp/model.bin',
              exists: true,
              isDirectory: false,
              openTarget: {
                kind: 'absolute-file',
                provider: 'local',
                absolutePath: '/tmp/model.bin',
                grantId: 'g-2'
              }
            },
            _meta: meta
          }
        }
        if (grantIdOf(args.params) === 'g-1') {
          return {
            id: 'rpc',
            ok: false,
            error: { code: 'runtime_error', message: 'terminal_file_grant_expired' },
            _meta: meta
          }
        }
        return args.method === 'files.statTerminalArtifact'
          ? {
              id: 'rpc',
              ok: true,
              result: { size: bytes.length, isDirectory: false, mtime: 1, ctime: 1 },
              _meta: meta
            }
          : {
              id: 'rpc',
              ok: true,
              result: {
                contentBase64: Buffer.from(bytes).toString('base64'),
                bytesRead: bytes.length,
                eof: true
              },
              _meta: meta
            }
      }
    )

    const read = await readRuntimeFileBytes(
      { ...granted, filePath: '/tmp/model.bin', relativePath: '/tmp/model.bin' },
      1024
    )

    expect(read).toEqual({ kind: 'ok', bytes })
  })
})
