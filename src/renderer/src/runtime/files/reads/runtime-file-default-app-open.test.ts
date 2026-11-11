import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openRuntimeFileWithDefaultApp } from './runtime-file-default-app-open'
import {
  fsAppendDownloadedFileChunk,
  fsDownloadFile,
  fsFinishDownloadedFile,
  fsStartDownloadedFile,
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from '../runtime-file-client-test-harness'
import { TERMINAL_ARTIFACT_CHUNK_RUNTIME_CAPABILITY } from '../../../../../shared/file-access/files-runtime-capabilities'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../../shared/protocol-version'

installRuntimeFileClientEnvironment()

const openFilePath = vi.fn()

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined
}

beforeEach(() => {
  openFilePath.mockReset()
  openFilePath.mockResolvedValue(true)
  Object.assign(window.api, { shell: { openFilePath } })
})

describe('openRuntimeFileWithDefaultApp', () => {
  it('opens a file on this computer in place', async () => {
    await expect(
      openRuntimeFileWithDefaultApp({ target: { kind: 'local' }, filePath: '/repo/report.docx' })
    ).resolves.toBe(true)
    expect(openFilePath).toHaveBeenCalledWith('/repo/report.docx', 'local')
    expect(fsDownloadFile).not.toHaveBeenCalled()
  })

  it('downloads an SSH file before the OS opens the saved copy', async () => {
    fsDownloadFile.mockResolvedValue({ canceled: false, destinationPath: '/dl/report.docx' })

    await openRuntimeFileWithDefaultApp({
      target: { kind: 'local' },
      filePath: '/home/me/report.docx',
      connectionId: 'ssh-1'
    })

    expect(fsDownloadFile).toHaveBeenCalledWith({
      filePath: '/home/me/report.docx',
      connectionId: 'ssh-1'
    })
    expect(openFilePath).toHaveBeenCalledWith('/dl/report.docx', 'local')
  })

  const scratchRoot = `/state/chat-scratch/${'a'.repeat(32)}`
  it.each([
    {
      name: 'a workspace file',
      filePath: '/srv/repo/deck/slides.pptx',
      relativePath: 'deck/slides.pptx',
      host: { worktree: 'id:wt-1', relativePath: 'deck/slides.pptx' }
    },
    {
      name: "a chat's scratch file",
      filePath: `${scratchRoot}/slides.pptx`,
      relativePath: `${scratchRoot}/slides.pptx`,
      host: { worktree: `path:${scratchRoot}`, relativePath: 'slides.pptx' }
    }
  ])('streams $name on a paired host to the saved copy it opens', async (file) => {
    const bytes = Buffer.from('PK\u0003\u0004slides')
    runtimeEnvironmentCall.mockImplementation(
      async (args: { method: string; params?: unknown }) => {
        if (args.method !== 'files.readChunk') {
          throw new Error(`unexpected ${args.method}`)
        }
        expect(args.params).toMatchObject(file.host)
        const offset = Number(fieldOf(args.params, 'offset'))
        const page = bytes.subarray(offset, offset + 6)
        return {
          id: 'rpc',
          ok: true,
          result: {
            contentBase64: page.toString('base64'),
            bytesRead: page.length,
            eof: offset + page.length >= bytes.length
          },
          _meta: { runtimeId: 'remote-runtime' }
        }
      }
    )
    fsStartDownloadedFile.mockResolvedValue({ canceled: false, transferId: 't-1' })
    fsFinishDownloadedFile.mockResolvedValue({
      canceled: false,
      destinationPath: '/dl/slides.pptx'
    })

    await openRuntimeFileWithDefaultApp({
      target: { kind: 'environment', environmentId: 'env-1' },
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: 'wt-1'
    })

    expect(fsStartDownloadedFile).toHaveBeenCalledWith({ suggestedName: 'slides.pptx' })
    const saved = fsAppendDownloadedFileChunk.mock.calls.map(([chunk]) =>
      String(fieldOf(chunk, 'contentBase64'))
    )
    expect(Buffer.concat(saved.map((page) => Buffer.from(page, 'base64')))).toEqual(bytes)
    expect(openFilePath).toHaveBeenCalledWith('/dl/slides.pptx', 'local')
  })

  // Why: the tab keeps the grant its read used, and the host expires it while the tab sits open.
  it('renews a lapsed grant before downloading a host file outside every workspace', async () => {
    const meta = { runtimeId: 'remote-runtime' }
    const statusGet = runtimeEnvironmentTransportCall.getMockImplementation()
    runtimeEnvironmentTransportCall.mockImplementation(async (args) =>
      args.method === 'status.get'
        ? {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'remote-runtime',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
              capabilities: [TERMINAL_ARTIFACT_CHUNK_RUNTIME_CAPABILITY]
            },
            _meta: meta
          }
        : statusGet?.(args)
    )
    const chunkGrants: unknown[] = []
    runtimeEnvironmentCall.mockImplementation(async ({ method, params }) => {
      const grantId = fieldOf(params, 'grantId')
      if (method === 'files.resolveTerminalPath') {
        return {
          id: 'rpc',
          ok: true,
          result: {
            worktree: 'wt-1',
            relativePath: null,
            absolutePath: '/tmp/out.zip',
            exists: true,
            isDirectory: false,
            openTarget: {
              kind: 'absolute-file',
              provider: 'local',
              absolutePath: '/tmp/out.zip',
              grantId: 'g-2'
            }
          },
          _meta: meta
        }
      }
      if (grantId === 'g-1') {
        return {
          id: 'rpc',
          ok: false,
          error: { code: 'runtime_error', message: 'terminal_file_grant_expired' },
          _meta: meta
        }
      }
      if (method === 'files.readTerminalArtifactChunk') {
        chunkGrants.push(grantId)
        return {
          id: 'rpc',
          ok: true,
          result: { contentBase64: 'AQID', bytesRead: 3, eof: true },
          _meta: meta
        }
      }
      throw new Error(`unexpected ${method}`)
    })
    fsStartDownloadedFile.mockResolvedValue({ canceled: false, transferId: 't-1' })
    fsFinishDownloadedFile.mockResolvedValue({ canceled: false, destinationPath: '/dl/out.zip' })

    await openRuntimeFileWithDefaultApp({
      target: { kind: 'environment', environmentId: 'env-1' },
      filePath: '/tmp/out.zip',
      relativePath: '/tmp/out.zip',
      worktreeId: 'wt-1',
      terminalArtifactGrantId: 'g-1'
    })

    expect(chunkGrants).toEqual(['g-2'])
    expect(openFilePath).toHaveBeenCalledWith('/dl/out.zip', 'local')
  })

  it('opens nothing when the save dialog is cancelled', async () => {
    fsDownloadFile.mockResolvedValue({ canceled: true })

    await expect(
      openRuntimeFileWithDefaultApp({
        target: { kind: 'local' },
        filePath: '/home/me/report.docx',
        connectionId: 'ssh-1'
      })
    ).resolves.toBe(true)
    expect(openFilePath).not.toHaveBeenCalled()
  })
})
