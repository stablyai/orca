import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveAuthorizedPathMock,
  statMock
} from '../../src/main/runtime/orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from '../../src/main/runtime/orca-runtime-files-test-harness'
import { RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES } from '../../src/main/runtime/files/file-preview-budget'
import { REMOTE_RPC_MAX_CONTENT_BYTES } from '../../src/shared/remote-rpc-content-budget'

vi.mock('fs', async () =>
  (await import('../../src/main/runtime/orca-runtime-files-mock-registry')).fsModuleMock()
)
vi.mock('fs/promises', async () =>
  (await import('../../src/main/runtime/orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  '../../src/main/runtime/file-watcher-host',
  async () =>
    (await import('../../src/main/runtime/orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../../src/main/ipc/filesystem/filesystem-auth', async () =>
  (
    await import('../../src/main/runtime/orca-runtime-files-mock-registry')
  ).filesystemAuthModuleMock()
)
vi.mock('../../src/main/git/runner', async () =>
  (await import('../../src/main/runtime/orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../../src/main/ipc/local-worktree-runtime-options',
  async () =>
    (await import('../../src/main/runtime/orca-runtime-files-mock-registry'))
      .localWorktreeRuntimeOptionsMock
)

import {
  readRuntimeFileContent,
  readRuntimeFilePreview
} from '../../src/renderer/src/runtime/runtime-file-read-client'
import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  fsReadFile
} from '../../src/renderer/src/runtime/runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('extensionless remote worktree image routing', () => {
  useRuntimeFileCommandsLifecycle()
  const previewTempDirs: string[] = []
  const pngImage = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64'
  )

  afterEach(async () => {
    await Promise.all(previewTempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    previewTempDirs.length = 0
  })

  async function previewFixture(size = Buffer.byteLength('fake-png')): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'orca-preview-budget-'))
    previewTempDirs.push(dir)
    await writeFile(join(dir, 'logo.png'), Buffer.alloc(size, 0x61))
    return dir
  }

  it.each([
    { size: 128, route: 'preview' },
    { size: 128, route: 'editor' },
    { size: RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES + 1, route: 'preview' },
    { size: RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES + 1, route: 'editor' }
  ])(
    'previews an extensionless remote worktree image through $route ($size bytes)',
    async ({ size, route }) => {
      const dir = await previewFixture()
      const image = Buffer.alloc(size)
      pngImage.copy(image)
      await writeFile(join(dir, 'downloaded-image'), image)
      statMock.mockResolvedValue({ size: image.length, isFile: () => true })
      const { commands } = createRuntimeFileCommands({ path: dir })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      runtimeEnvironmentCall.mockImplementation(async ({ method, params }) => {
        expect(params).toMatchObject({ worktree: 'id:wt-1', relativePath: 'downloaded-image' })
        let result: unknown
        try {
          if (method === 'files.read') {
            result = await commands.readMobileFile('id:wt-1', 'downloaded-image')
          } else if (method === 'files.readPreview') {
            result = await commands.readFileExplorerPreview(
              'id:wt-1',
              'downloaded-image',
              REMOTE_RPC_MAX_CONTENT_BYTES
            )
          } else if (method === 'files.stat') {
            result = { size: image.length, isDirectory: false, mtime: 1, ctime: 1 }
          } else if (
            method === 'files.readChunk' &&
            typeof params === 'object' &&
            params !== null &&
            'offset' in params &&
            'length' in params
          ) {
            result = await commands.readFileExplorerChunk(
              'id:wt-1',
              'downloaded-image',
              Number(params.offset),
              Number(params.length)
            )
          } else {
            throw new Error(`Unexpected RPC: ${method}`)
          }
          return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
        } catch (error) {
          return {
            id: 'rpc',
            ok: false,
            error: {
              code: 'runtime_error',
              message: error instanceof Error ? error.message : String(error)
            },
            _meta: { runtimeId: 'remote-runtime' }
          }
        }
      })
      await expect(
        route === 'editor'
          ? readRuntimeFileContent({
              target: { kind: 'environment', environmentId: 'env-1' },
              worktreeId: 'wt-1',
              filePath: '/remote/repo/downloaded-image',
              relativePath: 'downloaded-image',
              pageOversizedBinary: true
            })
          : readRuntimeFilePreview(
              {
                target: { kind: 'environment', environmentId: 'env-1' },
                worktreeId: 'wt-1',
                worktreePath: '/remote/repo'
              },
              '/remote/repo/downloaded-image',
              { kind: 'chat-image' }
            )
      ).resolves.toEqual({
        content: image.toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
      expect(fsReadFile).not.toHaveBeenCalled()
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'files.readPreview' })
      )
      if (size > RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES) {
        expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
          expect.objectContaining({ method: 'files.readChunk' })
        )
      }
    }
  )
})
