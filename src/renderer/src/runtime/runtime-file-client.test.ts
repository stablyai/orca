/* eslint-disable max-lines -- Why: the runtime file client mirrors the file
preload API plus remote fallbacks; keeping route coverage together makes local
versus environment behavior easy to audit. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  copyRuntimePath,
  createRuntimePath,
  deleteRuntimePath,
  getRuntimeFileReadScope,
  importExternalPathsToRuntime,
  listRuntimeFiles,
  listRuntimeMarkdownDocuments,
  readRuntimeDirectory,
  readRuntimeFileContent,
  readRuntimeFilePreview,
  renameRuntimePath,
  searchRuntimeFiles,
  statRuntimePath,
  subscribeRuntimeFileChanges,
  type RuntimeReadableFileContent
} from './runtime-file-client'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

const fsReadFile = vi.fn()
const fsOnChanged = vi.fn()
const fsCopy = vi.fn()
const fsCreateDir = vi.fn()
const fsCreateFile = vi.fn()
const fsRename = vi.fn()
const fsDeletePath = vi.fn()
const fsStat = vi.fn()
const fsImportExternalPaths = vi.fn()
const fsStageExternalPathsForRuntimeUpload = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const runtimeEnvironmentSubscribe = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  fsReadFile.mockReset()
  fsOnChanged.mockReset()
  fsCopy.mockReset()
  fsCreateDir.mockReset()
  fsCreateFile.mockReset()
  fsRename.mockReset()
  fsDeletePath.mockReset()
  fsStat.mockReset()
  fsImportExternalPaths.mockReset()
  fsStageExternalPathsForRuntimeUpload.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentSubscribe.mockReset()
  runtimeCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: { method: string }) => {
    if (args.method === 'status.get') {
      return Promise.resolve({
        id: 'status',
        ok: true,
        result: {
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
    }
    return runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      fs: {
        readFile: fsReadFile,
        onFsChanged: fsOnChanged,
        copy: fsCopy,
        createDir: fsCreateDir,
        createFile: fsCreateFile,
        rename: fsRename,
        deletePath: fsDeletePath,
        stat: fsStat,
        importExternalPaths: fsImportExternalPaths,
        stageExternalPathsForRuntimeUpload: fsStageExternalPathsForRuntimeUpload
      },
      runtime: { call: runtimeCall },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCall,
        subscribe: runtimeEnvironmentSubscribe
      }
    }
  })
})

describe('runtime file client', () => {
  it('uses local filesystem reads when no remote runtime is active', async () => {
    const localResult: RuntimeReadableFileContent = { content: 'hello', isBinary: false }
    fsReadFile.mockResolvedValue(localResult)

    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: null },
        filePath: '/repo/readme.md',
        relativePath: 'readme.md',
        worktreeId: 'wt-1',
        connectionId: 'ssh-1'
      })
    ).resolves.toBe(localResult)

    expect(fsReadFile).toHaveBeenCalledWith({ filePath: '/repo/readme.md', connectionId: 'ssh-1' })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes worktree-relative text reads through the selected runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        worktree: 'wt-1',
        relativePath: 'src/index.ts',
        content: 'export {}\n',
        truncated: false,
        byteLength: 10
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        filePath: '/remote/repo/src/index.ts',
        relativePath: 'src/index.ts',
        worktreeId: 'wt-1'
      })
    ).resolves.toEqual({ content: 'export {}\n', isBinary: false })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.read',
      params: { worktree: 'wt-1', relativePath: 'src/index.ts' },
      timeoutMs: 15_000
    })
    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('keeps external absolute-path files on the local filesystem path', async () => {
    const localResult: RuntimeReadableFileContent = { content: 'scratch', isBinary: false }
    fsReadFile.mockResolvedValue(localResult)

    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        filePath: '/Users/me/scratch.md',
        relativePath: '/Users/me/scratch.md'
      })
    ).resolves.toBe(localResult)

    expect(fsReadFile).toHaveBeenCalledWith({
      filePath: '/Users/me/scratch.md',
      connectionId: undefined
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('rejects remote-owned text reads that are not worktree-relative', async () => {
    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        filePath: '/tmp/scratch.md',
        relativePath: '/tmp/scratch.md',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('Remote file is outside the owning runtime worktree')

    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        filePath: '/remote/repo/unknown.md',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('Remote file is outside the owning runtime worktree')
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('rejects truncated remote reads instead of returning partial editable content', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        worktree: 'wt-1',
        relativePath: 'large.log',
        content: 'partial',
        truncated: true,
        byteLength: 524_288
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        filePath: '/remote/repo/large.log',
        relativePath: 'large.log',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('Remote file is too large to open in the editor')
  })

  it('uses the active runtime id as the dedupe scope', () => {
    expect(getRuntimeFileReadScope({ activeRuntimeEnvironmentId: 'env-1' }, 'ssh-1')).toBe(
      'runtime:env-1'
    )
    expect(getRuntimeFileReadScope({ activeRuntimeEnvironmentId: null }, 'ssh-1')).toBe('ssh-1')
  })

  it('routes directory reads through the selected runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: [{ name: 'src', isDirectory: true }],
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      readRuntimeDirectory(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/src'
      )
    ).resolves.toEqual([{ name: 'src', isDirectory: true }])

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readDir',
      params: { worktree: 'wt-1', relativePath: 'src' },
      timeoutMs: 15_000
    })
  })

  it('routes Windows drive paths case-insensitively through the selected runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: [],
      _meta: { runtimeId: 'remote-runtime' }
    })

    await readRuntimeDirectory(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: 'C:\\Repo'
      },
      'c:\\repo\\Src'
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readDir',
      params: { worktree: 'wt-1', relativePath: 'Src' },
      timeoutMs: 15_000
    })
  })

  it('routes forward-slash UNC paths through the selected runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: [],
      _meta: { runtimeId: 'remote-runtime' }
    })

    await readRuntimeDirectory(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '//Server/Share/Repo'
      },
      '//server/share/repo/src'
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readDir',
      params: { worktree: 'wt-1', relativePath: 'src' },
      timeoutMs: 15_000
    })
  })

  it('routes preview reads through the selected runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { content: 'base64', isBinary: true, isImage: true, mimeType: 'image/png' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      readRuntimeFilePreview(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/images/logo.png'
      )
    ).resolves.toEqual({
      content: 'base64',
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readPreview',
      params: { worktree: 'wt-1', relativePath: 'images/logo.png' },
      timeoutMs: 15_000
    })
  })

  it('does not fall back to client-local preview reads for remote-owned files outside the worktree', async () => {
    await expect(
      readRuntimeFilePreview(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/tmp/logo.png'
      )
    ).rejects.toThrow('outside the owning runtime worktree')

    expect(fsReadFile).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes root directory reads with an empty relative path', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: [],
      _meta: { runtimeId: 'remote-runtime' }
    })

    await readRuntimeDirectory(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      '/remote/repo'
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readDir',
      params: { worktree: 'wt-1', relativePath: '' },
      timeoutMs: 15_000
    })
  })

  it('does not fall back to client-local directory reads for remote-owned paths outside the worktree', async () => {
    await expect(
      readRuntimeDirectory(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo',
          connectionId: 'ssh-1'
        },
        '/tmp'
      )
    ).rejects.toThrow('outside the owning runtime worktree')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes create, rename, copy, and delete mutations through the selected runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const context = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/remote/repo'
    }

    await createRuntimePath(context, '/remote/repo/src/new.ts', 'file')
    await renameRuntimePath(context, '/remote/repo/src/new.ts', '/remote/repo/src/renamed.ts')
    await copyRuntimePath(
      context,
      '/remote/repo/src/renamed.ts',
      '/remote/repo/src/renamed copy.ts'
    )
    await deleteRuntimePath(context, '/remote/repo/src/renamed.ts', false)

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'files.createFile',
      params: { worktree: 'wt-1', relativePath: 'src/new.ts' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.rename',
      params: {
        worktree: 'wt-1',
        oldRelativePath: 'src/new.ts',
        newRelativePath: 'src/renamed.ts'
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'files.copy',
      params: {
        worktree: 'wt-1',
        sourceRelativePath: 'src/renamed.ts',
        destinationRelativePath: 'src/renamed copy.ts'
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(4, {
      selector: 'env-1',
      method: 'files.delete',
      params: { worktree: 'wt-1', relativePath: 'src/renamed.ts', recursive: false },
      timeoutMs: 15_000
    })
  })

  it('does not fall back to client-local mutations for remote-owned paths outside the worktree', async () => {
    const context = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/remote/repo'
    }

    await expect(createRuntimePath(context, '/tmp/new.ts', 'file')).rejects.toThrow(
      'outside the owning runtime worktree'
    )
    await expect(
      renameRuntimePath(context, '/remote/repo/src/new.ts', '/tmp/renamed.ts')
    ).rejects.toThrow('outside the owning runtime worktree')
    await expect(
      copyRuntimePath(context, '/remote/repo/src/new.ts', '/tmp/copied.ts')
    ).rejects.toThrow('outside the owning runtime worktree')
    await expect(deleteRuntimePath(context, '/tmp/new.ts')).rejects.toThrow(
      'outside the owning runtime worktree'
    )

    expect(fsCreateFile).not.toHaveBeenCalled()
    expect(fsRename).not.toHaveBeenCalled()
    expect(fsCopy).not.toHaveBeenCalled()
    expect(fsDeletePath).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('does not fall back to client-local mutations when a remote Windows path escapes the worktree', async () => {
    const context = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: 'C:\\repo'
    }

    await expect(createRuntimePath(context, 'D:\\repo\\new.ts', 'file')).rejects.toThrow(
      'outside the owning runtime worktree'
    )
    await expect(
      createRuntimePath(context, '\\\\server\\share\\repo\\new.ts', 'file')
    ).rejects.toThrow('outside the owning runtime worktree')

    expect(fsCreateFile).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('keeps copy operations on local filesystem IPC when no runtime is active', async () => {
    await copyRuntimePath(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      '/repo/a.md',
      '/repo/a copy.md'
    )

    expect(fsCopy).toHaveBeenCalledWith({
      sourcePath: '/repo/a.md',
      destinationPath: '/repo/a copy.md',
      connectionId: undefined
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('preserves the SSH connection for copy operations when no runtime is active', async () => {
    await copyRuntimePath(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: 'ssh-1'
      },
      '/repo/a.md',
      '/repo/a copy.md'
    )

    expect(fsCopy).toHaveBeenCalledWith({
      sourcePath: '/repo/a.md',
      destinationPath: '/repo/a copy.md',
      connectionId: 'ssh-1'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('uploads staged local drops into the selected runtime environment', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/assets',
          status: 'staged',
          name: 'assets',
          kind: 'directory',
          entries: [
            { relativePath: '', kind: 'directory' },
            { relativePath: 'logo.png', kind: 'file', contentBase64: 'cG5n' }
          ]
        }
      ]
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'stat-destination-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'create-destination-dir',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'stat-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'create-dir',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'write-file',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'commit-upload',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'delete-temp',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      importExternalPathsToRuntime(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        ['/Users/me/assets'],
        '/remote/repo/uploads'
      )
    ).resolves.toEqual({
      results: [
        {
          sourcePath: '/Users/me/assets',
          status: 'imported',
          destPath: '/remote/repo/uploads/assets',
          kind: 'directory',
          renamed: false
        }
      ]
    })

    expect(fsStageExternalPathsForRuntimeUpload).toHaveBeenCalledWith({
      sourcePaths: ['/Users/me/assets']
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'files.stat',
      params: { worktree: 'wt-1', relativePath: 'uploads' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.createDir',
      params: { worktree: 'wt-1', relativePath: 'uploads' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'files.stat',
      params: { worktree: 'wt-1', relativePath: 'uploads/assets' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(4, {
      selector: 'env-1',
      method: 'files.createDirNoClobber',
      params: { worktree: 'wt-1', relativePath: 'uploads/assets' },
      timeoutMs: 15_000
    })
    const smallWriteCall = runtimeEnvironmentCall.mock.calls[4]?.[0] as {
      params: { relativePath: string }
    }
    expect(smallWriteCall.params.relativePath).toMatch(
      /^uploads\/assets\/\.logo\.png\.orca-upload-/
    )
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(5, {
      selector: 'env-1',
      method: 'files.writeBase64',
      params: {
        worktree: 'wt-1',
        relativePath: smallWriteCall.params.relativePath,
        contentBase64: 'cG5n'
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(6, {
      selector: 'env-1',
      method: 'files.commitUpload',
      params: {
        worktree: 'wt-1',
        tempRelativePath: smallWriteCall.params.relativePath,
        finalRelativePath: 'uploads/assets/logo.png'
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(7, {
      selector: 'env-1',
      method: 'files.delete',
      params: {
        worktree: 'wt-1',
        relativePath: smallWriteCall.params.relativePath,
        recursive: false
      },
      timeoutMs: 15_000
    })
    expect(fsImportExternalPaths).not.toHaveBeenCalled()
  })

  it('chunks large staged runtime uploads below the WebSocket frame budget', async () => {
    const firstChunk = 'A'.repeat(512 * 1024)
    const secondChunk = 'BBBBBBBB'
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/large.bin',
          status: 'staged',
          name: 'large.bin',
          kind: 'file',
          entries: [
            { relativePath: '', kind: 'file', contentBase64: `${firstChunk}${secondChunk}` }
          ]
        }
      ]
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'stat-destination-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'create-destination-dir',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'stat-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'write-chunk-1',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'write-chunk-2',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'commit-upload',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'delete-temp',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      importExternalPathsToRuntime(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        ['/Users/me/large.bin'],
        '/remote/repo/uploads'
      )
    ).resolves.toEqual({
      results: [
        {
          sourcePath: '/Users/me/large.bin',
          status: 'imported',
          destPath: '/remote/repo/uploads/large.bin',
          kind: 'file',
          renamed: false
        }
      ]
    })

    const chunkWriteCall = runtimeEnvironmentCall.mock.calls[3]?.[0] as {
      params: { relativePath: string }
    }
    expect(chunkWriteCall.params.relativePath).toMatch(/^uploads\/\.large\.bin\.orca-upload-/)
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(4, {
      selector: 'env-1',
      method: 'files.writeBase64Chunk',
      params: {
        worktree: 'wt-1',
        relativePath: chunkWriteCall.params.relativePath,
        contentBase64: firstChunk,
        append: false
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(5, {
      selector: 'env-1',
      method: 'files.writeBase64Chunk',
      params: {
        worktree: 'wt-1',
        relativePath: chunkWriteCall.params.relativePath,
        contentBase64: secondChunk,
        append: true
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(6, {
      selector: 'env-1',
      method: 'files.commitUpload',
      params: {
        worktree: 'wt-1',
        tempRelativePath: chunkWriteCall.params.relativePath,
        finalRelativePath: 'uploads/large.bin'
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(7, {
      selector: 'env-1',
      method: 'files.delete',
      params: {
        worktree: 'wt-1',
        relativePath: chunkWriteCall.params.relativePath,
        recursive: false
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.writeBase64' })
    )
  })

  it('cleans up staged runtime upload temp files when a later chunk fails', async () => {
    const firstChunk = 'A'.repeat(512 * 1024)
    const secondChunk = 'BBBBBBBB'
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/large.bin',
          status: 'staged',
          name: 'large.bin',
          kind: 'file',
          entries: [
            { relativePath: '', kind: 'file', contentBase64: `${firstChunk}${secondChunk}` }
          ]
        }
      ]
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'stat-destination-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'create-destination-dir',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'stat-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'write-chunk-1',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'write-chunk-2',
        ok: false,
        error: { code: 'write_failed', message: 'disk full' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'delete-temp',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      importExternalPathsToRuntime(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        ['/Users/me/large.bin'],
        '/remote/repo/uploads'
      )
    ).resolves.toMatchObject({
      results: [{ status: 'failed', reason: 'disk full' }]
    })

    const chunkCall = runtimeEnvironmentCall.mock.calls[3]?.[0] as
      | { params: { relativePath: string } }
      | undefined
    if (!chunkCall) {
      throw new Error('missing first chunk call')
    }
    const tempRelativePath = chunkCall.params.relativePath
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.commitUpload' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
      selector: 'env-1',
      method: 'files.delete',
      params: { worktree: 'wt-1', relativePath: tempRelativePath, recursive: false },
      timeoutMs: 15_000
    })
  })

  it('keeps local external imports on filesystem IPC when no runtime is active', async () => {
    fsImportExternalPaths.mockResolvedValue({
      results: [
        {
          sourcePath: '/Users/me/readme.md',
          status: 'imported',
          destPath: '/repo/readme.md',
          kind: 'file',
          renamed: false
        }
      ]
    })

    await importExternalPathsToRuntime(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: 'ssh-1'
      },
      ['/Users/me/readme.md'],
      '/repo',
      { ensureDestinationDir: true }
    )

    expect(fsImportExternalPaths).toHaveBeenCalledWith({
      sourcePaths: ['/Users/me/readme.md'],
      destDir: '/repo',
      connectionId: 'ssh-1',
      ensureDir: true
    })
    expect(fsStageExternalPathsForRuntimeUpload).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes text search through the selected runtime without sending client root paths', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { files: [], totalMatches: 0, truncated: false },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      searchRuntimeFiles(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        {
          query: 'needle',
          rootPath: '/remote/repo',
          caseSensitive: true,
          maxResults: 50
        }
      )
    ).resolves.toEqual({ files: [], totalMatches: 0, truncated: false })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.search',
      params: { worktree: 'wt-1', query: 'needle', caseSensitive: true, maxResults: 50 },
      timeoutMs: 15_000
    })
  })

  it('routes quick-open file listing through the selected runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: ['src/index.ts'],
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      listRuntimeFiles(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        {
          rootPath: '/remote/repo',
          excludePaths: ['/remote/repo-other']
        }
      )
    ).resolves.toEqual(['src/index.ts'])

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.listAll',
      params: { worktree: 'wt-1', excludePaths: ['/remote/repo-other'] },
      timeoutMs: 15_000
    })
  })

  it('routes markdown document listing and stat through the selected runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: [{ relativePath: 'readme.md' }],
      _meta: { runtimeId: 'remote-runtime' }
    })
    const context = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/remote/repo'
    }

    await listRuntimeMarkdownDocuments(context, '/remote/repo')
    await statRuntimePath(context, '/remote/repo/readme.md')

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'files.listMarkdownDocuments',
      params: { worktree: 'wt-1' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.stat',
      params: { worktree: 'wt-1', relativePath: 'readme.md' },
      timeoutMs: 15_000
    })
  })

  it('does not fall back to client-local stat for remote-owned paths outside the worktree', async () => {
    await expect(
      statRuntimePath(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/tmp/readme.md'
      )
    ).rejects.toThrow('outside the owning runtime worktree')

    await expect(
      statRuntimePath(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: 'C:\\repo'
        },
        '\\\\server\\share\\repo\\readme.md'
      )
    ).rejects.toThrow('outside the owning runtime worktree')

    expect(fsStat).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('uses the local fs changed stream when no runtime environment is active', async () => {
    const unsubscribe = vi.fn()
    const onPayload = vi.fn()
    fsOnChanged.mockReturnValue(unsubscribe)

    await expect(
      subscribeRuntimeFileChanges(
        {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'wt-1',
          worktreePath: '/repo'
        },
        onPayload
      )
    ).resolves.toBe(unsubscribe)

    expect(fsOnChanged).toHaveBeenCalledWith(onPayload)
    expect(runtimeEnvironmentSubscribe).not.toHaveBeenCalled()
  })

  it('maps runtime file watch events back to fs changed payloads', async () => {
    const onPayload = vi.fn()
    const unsubscribe = vi.fn()
    let onResponse: ((response: unknown) => void) | undefined
    runtimeEnvironmentSubscribe.mockImplementation((_args, callbacks) => {
      onResponse = callbacks.onResponse
      return Promise.resolve({ unsubscribe, sendBinary: vi.fn() })
    })

    const stop = await subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      onPayload
    )

    expect(runtimeEnvironmentSubscribe).toHaveBeenCalledWith(
      {
        selector: 'env-1',
        method: 'files.watch',
        params: { worktree: 'wt-1' },
        timeoutMs: 15_000
      },
      expect.any(Object)
    )

    onResponse?.({
      id: 'rpc-1',
      ok: true,
      result: {
        type: 'changed',
        worktree: 'wt-1',
        events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(onPayload).toHaveBeenCalledWith({
      worktreePath: '/remote/repo',
      events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
    })

    stop()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('shares one remote file watch subscription across listeners for the same worktree', async () => {
    const firstPayload = vi.fn()
    const secondPayload = vi.fn()
    const unsubscribe = vi.fn()
    let onResponse: ((response: unknown) => void) | undefined
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'unwatch',
      ok: true,
      result: { unsubscribed: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
    runtimeEnvironmentSubscribe.mockImplementation((_args, callbacks) => {
      onResponse = callbacks.onResponse
      return Promise.resolve({ unsubscribe, sendBinary: vi.fn() })
    })

    const firstStop = await subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      firstPayload
    )
    const secondStop = await subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      secondPayload
    )

    expect(runtimeEnvironmentSubscribe).toHaveBeenCalledTimes(1)
    onResponse?.({
      id: 'ready',
      ok: true,
      result: { type: 'ready', subscriptionId: 'files-watch-1' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    onResponse?.({
      id: 'changed',
      ok: true,
      result: {
        type: 'changed',
        worktree: 'wt-1',
        events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(firstPayload).toHaveBeenCalledWith({
      worktreePath: '/remote/repo',
      events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
    })
    expect(secondPayload).toHaveBeenCalledWith({
      worktreePath: '/remote/repo',
      events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
    })

    firstStop()
    expect(unsubscribe).not.toHaveBeenCalled()

    secondStop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.unwatch',
        params: { subscriptionId: 'files-watch-1' },
        timeoutMs: 5_000
      })
    )
  })
})
