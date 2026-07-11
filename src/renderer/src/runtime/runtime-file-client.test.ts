/* eslint-disable max-lines -- Why: the runtime file client mirrors the file
preload API plus remote fallbacks; keeping route coverage together makes local
versus environment behavior easy to audit. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelRuntimeFileList,
  copyRuntimePath,
  createRuntimePath,
  deleteRuntimePath,
  downloadRuntimeFile,
  getRuntimeFileReadScope,
  importExternalPathsToRuntime,
  listRuntimeFiles,
  listRuntimeMarkdownDocuments,
  readRuntimeDirectory,
  readRuntimeFileContent,
  readRuntimeFilePreview,
  renameRuntimePath,
  runtimePathExists,
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
const fsPathExists = vi.fn()
const fsSearch = vi.fn()
const fsListFiles = vi.fn()
const fsCancelListFiles = vi.fn()
const fsDownloadFile = vi.fn()
const fsSaveDownloadedFile = vi.fn()
const fsStartDownloadedFile = vi.fn()
const fsAppendDownloadedFileChunk = vi.fn()
const fsFinishDownloadedFile = vi.fn()
const fsCancelDownloadedFile = vi.fn()
const fsImportExternalPaths = vi.fn()
const fsStageExternalPathsForRuntimeUpload = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const runtimeEnvironmentSubscribe = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  clearRuntimeCompatibilityCacheForTests()
  fsReadFile.mockReset()
  fsOnChanged.mockReset()
  fsCopy.mockReset()
  fsCreateDir.mockReset()
  fsCreateFile.mockReset()
  fsRename.mockReset()
  fsDeletePath.mockReset()
  fsStat.mockReset()
  fsPathExists.mockReset()
  fsSearch.mockReset()
  fsListFiles.mockReset()
  fsCancelListFiles.mockReset()
  fsCancelListFiles.mockResolvedValue(undefined)
  fsDownloadFile.mockReset()
  fsSaveDownloadedFile.mockReset()
  fsStartDownloadedFile.mockReset()
  fsAppendDownloadedFileChunk.mockReset()
  fsFinishDownloadedFile.mockReset()
  fsCancelDownloadedFile.mockReset()
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
        pathExists: fsPathExists,
        search: fsSearch,
        listFiles: fsListFiles,
        cancelListFiles: fsCancelListFiles,
        downloadFile: fsDownloadFile,
        saveDownloadedFile: fsSaveDownloadedFile,
        startDownloadedFile: fsStartDownloadedFile,
        appendDownloadedFileChunk: fsAppendDownloadedFileChunk,
        finishDownloadedFile: fsFinishDownloadedFile,
        cancelDownloadedFile: fsCancelDownloadedFile,
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
        worktree: 'id:wt-1',
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
      params: { worktree: 'id:wt-1', relativePath: 'src/index.ts' },
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
        worktree: 'id:wt-1',
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

  it('falls back to files.readPreview when a remote binary file is opened', async () => {
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'files.read') {
        return Promise.resolve({
          id: 'rpc-read',
          ok: false,
          error: { code: 'runtime_error', message: 'binary_file' },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: 'rpc-preview',
        ok: true,
        result: {
          content: 'JVBERi0=',
          isBinary: true,
          isImage: true,
          mimeType: 'application/pdf'
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        filePath: '/remote/repo/doc.pdf',
        relativePath: 'doc.pdf',
        worktreeId: 'wt-1'
      })
    ).resolves.toEqual({
      content: 'JVBERi0=',
      isBinary: true,
      isImage: true,
      mimeType: 'application/pdf'
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.read',
      params: { worktree: 'id:wt-1', relativePath: 'doc.pdf' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readPreview',
      params: { worktree: 'id:wt-1', relativePath: 'doc.pdf' },
      timeoutMs: 15_000
    })
  })

  it('does not fall back to files.readPreview for non-binary remote read errors', async () => {
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'files.read') {
        return Promise.resolve({
          id: 'rpc-read',
          ok: false,
          error: { code: 'runtime_error', message: 'permission_denied' },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      throw new Error('files.readPreview should not be called')
    })

    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        filePath: '/remote/repo/secret.txt',
        relativePath: 'secret.txt',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('permission_denied')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.readPreview' })
    )
  })

  it('propagates a files.readPreview failure during the binary fallback', async () => {
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'files.read') {
        return Promise.resolve({
          id: 'rpc-read',
          ok: false,
          error: { code: 'runtime_error', message: 'binary_file' },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: 'rpc-preview',
        ok: false,
        error: { code: 'runtime_error', message: 'file_too_large' },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        filePath: '/remote/repo/huge.pdf',
        relativePath: 'huge.pdf',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('file_too_large')

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.readPreview' })
    )
  })

  it('does not fall back when a non-RPC error merely shares the binary_file message', async () => {
    // Why: only a typed RuntimeRpcCallError('binary_file') means the server
    // classified the file as binary. A transport-level failure that happens to
    // carry the same message text must propagate, not trigger a preview read.
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'files.read') {
        return Promise.reject(new Error('binary_file'))
      }
      throw new Error('files.readPreview should not be called')
    })

    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        filePath: '/remote/repo/doc.pdf',
        relativePath: 'doc.pdf',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('binary_file')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.readPreview' })
    )
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
      params: { worktree: 'id:wt-1', relativePath: 'src' },
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
      params: { worktree: 'id:wt-1', relativePath: 'Src' },
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
      params: { worktree: 'id:wt-1', relativePath: 'src' },
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
      params: { worktree: 'id:wt-1', relativePath: 'images/logo.png' },
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

  it('downloads remote runtime files in chunks instead of using preview content', async () => {
    fsStartDownloadedFile.mockResolvedValue({
      canceled: false,
      transferId: 'download-1',
      destinationPath: '/downloads/archive.zip'
    })
    fsAppendDownloadedFileChunk.mockResolvedValue({ ok: true })
    fsFinishDownloadedFile.mockResolvedValue({
      canceled: false,
      destinationPath: '/downloads/archive.zip'
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'preflight',
        ok: true,
        result: { contentBase64: 'YWJj', bytesRead: 3, eof: false },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'chunk-1',
        ok: true,
        result: { contentBase64: 'YWJj', bytesRead: 3, eof: false },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'chunk-2',
        ok: true,
        result: { contentBase64: 'ZA==', bytesRead: 1, eof: true },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/archive.zip',
        'archive.zip'
      )
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/archive.zip' })

    expect(fsStartDownloadedFile).toHaveBeenCalledWith({ suggestedName: 'archive.zip' })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'files.readChunk',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'archive.zip',
        offset: 0,
        length: 1
      },
      timeoutMs: 60_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.readChunk',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'archive.zip',
        offset: 0,
        length: 384 * 1024
      },
      timeoutMs: 60_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'files.readChunk',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'archive.zip',
        offset: 3,
        length: 384 * 1024
      },
      timeoutMs: 60_000
    })
    expect(fsAppendDownloadedFileChunk).toHaveBeenCalledTimes(2)
    expect(fsFinishDownloadedFile).toHaveBeenCalledWith({ transferId: 'download-1' })
    expect(fsCancelDownloadedFile).not.toHaveBeenCalled()
  })

  it('does not open the save dialog when the remote chunk probe fails for transport reasons', async () => {
    runtimeEnvironmentCall.mockRejectedValueOnce(new Error('connection dropped'))

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/archive.zip',
        'archive.zip'
      )
    ).rejects.toThrow('connection dropped')

    expect(fsStartDownloadedFile).not.toHaveBeenCalled()
    expect(fsSaveDownloadedFile).not.toHaveBeenCalled()
  })

  it('falls back to preview content when older remote runtimes lack chunked download', async () => {
    fsSaveDownloadedFile.mockResolvedValue({
      canceled: false,
      destinationPath: '/downloads/report.txt'
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'chunk-1',
        ok: false,
        error: {
          code: 'method_not_found',
          message: 'Unknown method: files.readChunk'
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'preview-1',
        ok: true,
        result: { content: 'hello\n', isBinary: false },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/report.txt',
        'report.txt'
      )
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/report.txt' })

    expect(fsStartDownloadedFile).not.toHaveBeenCalled()
    expect(fsSaveDownloadedFile).toHaveBeenCalledWith({
      suggestedName: 'report.txt',
      content: 'hello\n',
      encoding: 'utf8'
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.readPreview',
      params: { worktree: 'id:wt-1', relativePath: 'report.txt' },
      timeoutMs: 15_000
    })
    expect(fsCancelDownloadedFile).not.toHaveBeenCalled()
  })

  it('downloads a complete zero-byte recognized binary from an older remote runtime', async () => {
    fsSaveDownloadedFile.mockResolvedValue({
      canceled: false,
      destinationPath: '/downloads/empty.png'
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'chunk-1',
        ok: false,
        error: {
          code: 'method_not_found',
          message: 'Unknown method: files.readChunk'
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'preview-1',
        ok: true,
        result: { content: '', isBinary: true, isImage: true, mimeType: 'image/png' },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/empty.png',
        'empty.png'
      )
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/empty.png' })

    expect(fsStartDownloadedFile).not.toHaveBeenCalled()
    expect(fsSaveDownloadedFile).toHaveBeenCalledWith({
      suggestedName: 'empty.png',
      content: '',
      encoding: 'base64'
    })
  })

  it('asks users to update older remote runtimes when preview fallback cannot download the file', async () => {
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'chunk-1',
        ok: false,
        error: {
          code: 'method_not_found',
          message: 'Unknown method: files.readChunk'
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'preview-1',
        ok: false,
        error: { code: 'runtime_error', message: 'file_too_large' },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/archive.zip',
        'archive.zip'
      )
    ).rejects.toThrow('Remote file download requires a newer Orca server')

    expect(fsStartDownloadedFile).not.toHaveBeenCalled()
    expect(fsSaveDownloadedFile).not.toHaveBeenCalled()
  })

  it('cancels the local temp download when a remote chunk fails', async () => {
    fsStartDownloadedFile.mockResolvedValue({
      canceled: false,
      transferId: 'download-1',
      destinationPath: '/downloads/archive.zip'
    })
    fsCancelDownloadedFile.mockResolvedValue({ ok: true })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'preflight',
        ok: true,
        result: { contentBase64: 'YWJj', bytesRead: 3, eof: false },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'chunk-1',
        ok: true,
        result: { contentBase64: 'YWJj', bytesRead: 3, eof: false },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockRejectedValueOnce(new Error('connection dropped'))

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/archive.zip',
        'archive.zip'
      )
    ).rejects.toThrow('connection dropped')

    expect(fsCancelDownloadedFile).toHaveBeenCalledWith({ transferId: 'download-1' })
    expect(fsFinishDownloadedFile).not.toHaveBeenCalled()
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
      params: { worktree: 'id:wt-1', relativePath: '' },
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
      params: { worktree: 'id:wt-1', relativePath: 'src/new.ts' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.rename',
      params: {
        worktree: 'id:wt-1',
        oldRelativePath: 'src/new.ts',
        newRelativePath: 'src/renamed.ts'
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'files.copy',
      params: {
        worktree: 'id:wt-1',
        sourceRelativePath: 'src/renamed.ts',
        destinationRelativePath: 'src/renamed copy.ts'
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(4, {
      selector: 'env-1',
      method: 'files.delete',
      params: { worktree: 'id:wt-1', relativePath: 'src/renamed.ts', recursive: false },
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
      params: { worktree: 'id:wt-1', relativePath: 'uploads' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.createDir',
      params: { worktree: 'id:wt-1', relativePath: 'uploads' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'files.stat',
      params: { worktree: 'id:wt-1', relativePath: 'uploads/assets' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(4, {
      selector: 'env-1',
      method: 'files.createDirNoClobber',
      params: { worktree: 'id:wt-1', relativePath: 'uploads/assets' },
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
        worktree: 'id:wt-1',
        relativePath: smallWriteCall.params.relativePath,
        contentBase64: 'cG5n'
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(6, {
      selector: 'env-1',
      method: 'files.commitUpload',
      params: {
        worktree: 'id:wt-1',
        tempRelativePath: smallWriteCall.params.relativePath,
        finalRelativePath: 'uploads/assets/logo.png'
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(7, {
      selector: 'env-1',
      method: 'files.delete',
      params: {
        worktree: 'id:wt-1',
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
        worktree: 'id:wt-1',
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
        worktree: 'id:wt-1',
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
        worktree: 'id:wt-1',
        tempRelativePath: chunkWriteCall.params.relativePath,
        finalRelativePath: 'uploads/large.bin'
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(7, {
      selector: 'env-1',
      method: 'files.delete',
      params: {
        worktree: 'id:wt-1',
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
      params: { worktree: 'id:wt-1', relativePath: tempRelativePath, recursive: false },
      timeoutMs: 15_000
    })
  })

  it('removes a created runtime directory import root when a nested file upload fails', async () => {
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
        id: 'stat-destination',
        ok: true,
        result: { size: 0, isDirectory: true, mtime: 1 },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'stat-import-root-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'create-import-root',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'write-file',
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
      .mockResolvedValueOnce({
        id: 'delete-import-root',
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
    ).resolves.toMatchObject({
      results: [{ status: 'failed', reason: 'disk full' }]
    })

    const writeCall = runtimeEnvironmentCall.mock.calls[3]?.[0] as
      | { params: { relativePath: string } }
      | undefined
    if (!writeCall) {
      throw new Error('missing failed file write call')
    }
    expect(writeCall.params.relativePath).toMatch(/^uploads\/assets\/\.logo\.png\.orca-upload-/)
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
      selector: 'env-1',
      method: 'files.delete',
      params: { worktree: 'id:wt-1', relativePath: 'uploads/assets', recursive: true },
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
      params: { worktree: 'id:wt-1', query: 'needle', caseSensitive: true, maxResults: 50 },
      timeoutMs: 15_000
    })
  })

  it('rejects oversized text search input before local IPC or runtime RPC', async () => {
    const oversizedQuery = 'x'.repeat(9 * 1024)

    await expect(
      searchRuntimeFiles(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        {
          query: oversizedQuery,
          rootPath: '/remote/repo',
          maxResults: 50
        }
      )
    ).resolves.toEqual({ files: [], totalMatches: 0, truncated: false })

    await expect(
      searchRuntimeFiles(
        {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          connectionId: 'ssh-1'
        },
        {
          query: 'needle',
          rootPath: '/repo',
          includePattern: 'secret-token-value'.repeat(1024),
          maxResults: 50
        }
      )
    ).resolves.toEqual({ files: [], totalMatches: 0, truncated: false })

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(fsSearch).not.toHaveBeenCalled()
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
      params: { worktree: 'id:wt-1', excludePaths: ['/remote/repo-other'] },
      timeoutMs: 15_000
    })
  })

  it('passes the cancellation token through the IPC file listing path (#7721)', async () => {
    fsListFiles.mockResolvedValue(['src/index.ts'])

    await expect(
      listRuntimeFiles(
        {
          settings: {},
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo',
          connectionId: 'ssh-1'
        },
        {
          rootPath: '/remote/repo',
          requestToken: 'token-1'
        }
      )
    ).resolves.toEqual(['src/index.ts'])

    expect(fsListFiles).toHaveBeenCalledWith({
      rootPath: '/remote/repo',
      connectionId: 'ssh-1',
      excludePaths: undefined,
      requestToken: 'token-1'
    })
  })

  it('cancelRuntimeFileList aborts the IPC listing but not environment listings (#7721)', () => {
    cancelRuntimeFileList(
      {
        settings: {},
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo',
        connectionId: 'ssh-1'
      },
      'token-1'
    )
    expect(fsCancelListFiles).toHaveBeenCalledWith({ requestToken: 'token-1' })

    fsCancelListFiles.mockClear()
    cancelRuntimeFileList(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      'token-2'
    )
    expect(fsCancelListFiles).not.toHaveBeenCalled()
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
      params: { worktree: 'id:wt-1' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.stat',
      params: { worktree: 'id:wt-1', relativePath: 'readme.md' },
      timeoutMs: 15_000
    })
  })

  it('uses quiet local path existence checks when no runtime environment is active', async () => {
    fsPathExists.mockResolvedValueOnce(false)

    await expect(
      runtimePathExists(
        {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          connectionId: 'ssh-1'
        },
        '/repo/untitled.md'
      )
    ).resolves.toBe(false)

    expect(fsPathExists).toHaveBeenCalledWith({
      filePath: '/repo/untitled.md',
      connectionId: 'ssh-1'
    })
    expect(fsStat).not.toHaveBeenCalled()
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
        params: { worktree: 'id:wt-1' },
        timeoutMs: 15_000
      },
      expect.any(Object)
    )

    onResponse?.({
      id: 'rpc-1',
      ok: true,
      result: {
        type: 'changed',
        worktree: 'id:wt-1',
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
        worktree: 'id:wt-1',
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

  it('delegates stopped pre-ready web shared file watch cleanup to the subscription handle', async () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
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

    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.unwatch' })
    )

    onResponse?.({
      id: 'ready',
      ok: true,
      result: { type: 'ready', subscriptionId: 'files-watch-late' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.unwatch' })
    )
  })

  it('delegates stopped ready web shared file watch cleanup to the subscription handle', async () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
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

    onResponse?.({
      id: 'ready',
      ok: true,
      result: { type: 'ready', subscriptionId: 'files-watch-ready' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    stop()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.unwatch' })
    )
  })
})
