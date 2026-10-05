import { describe, expect, it } from 'vitest'
import { readRuntimeFileRange, statRuntimeReadTarget } from './runtime-file-range-client'
import {
  readEditorCsvFileContent,
  CSV_PAGED_PREVIEW_BYTES
} from '../components/editor/editor-csv-file-content'
import {
  fsReadFile,
  fsReadFileChunk,
  fsStat,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()
const localArgs = {
  settings: null,
  filePath: '/repo/large.csv',
  relativePath: 'large.csv',
  worktreeId: 'folder:workspace'
}
const snapshot = { size: 100 * 1024 * 1024, isDirectory: false, mtime: 123 }

describe('CSV range routing', () => {
  it('preserves local file access for metadata and chunk reads', async () => {
    const access = { kind: 'user-file' } as const
    fsStat.mockResolvedValue(snapshot)
    fsReadFileChunk.mockResolvedValue({ contentBase64: 'YWJj', bytesRead: 3, eof: false })
    await statRuntimeReadTarget({ ...localArgs, access })
    await readRuntimeFileRange({ ...localArgs, access }, 0, 3)
    expect(fsStat).toHaveBeenCalledWith({
      filePath: localArgs.filePath,
      connectionId: undefined,
      access
    })
    expect(fsReadFileChunk).toHaveBeenCalledWith({
      filePath: localArgs.filePath,
      connectionId: undefined,
      offset: 0,
      length: 3,
      access
    })
  })
  it('uses bounded local reads and preserves explicit SSH ownership', async () => {
    fsReadFileChunk.mockResolvedValue({ contentBase64: 'YWJj', bytesRead: 3, eof: false })
    expect(await readRuntimeFileRange(localArgs, 100, 3)).toEqual(new Uint8Array([97, 98, 99]))
    await readRuntimeFileRange(
      { ...localArgs, connectionId: 'ssh-1', expectedExternalSshTargetId: 'ssh-1' },
      100,
      3
    )
    expect(fsReadFileChunk).toHaveBeenLastCalledWith({
      filePath: localArgs.filePath,
      connectionId: 'ssh-1',
      access: undefined,
      offset: 100,
      length: 3
    })
    expect(fsReadFile).not.toHaveBeenCalled()
  })
  it('routes paired folder workspaces through the existing host chunk RPC', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'chunk',
      ok: true,
      result: { contentBase64: 'YWJj', bytesRead: 3, eof: false }
    })
    await readRuntimeFileRange(
      { ...localArgs, settings: { activeRuntimeEnvironmentId: 'env-1' } },
      10,
      3
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'files.readChunk',
        params: {
          worktree: 'id:folder:workspace',
          relativePath: 'large.csv',
          offset: 10,
          length: 3
        }
      })
    )
    expect(fsReadFileChunk).not.toHaveBeenCalled()
  })
  it('does not substitute a local file for an unavailable or changed remote owner', async () => {
    await expect(
      readRuntimeFileRange(
        { ...localArgs, settings: { activeRuntimeEnvironmentId: 'env-1' }, worktreeId: undefined },
        0,
        3
      )
    ).rejects.toThrow('owning')
    await expect(
      readRuntimeFileRange(
        { ...localArgs, connectionId: 'ssh-2', expectedExternalSshTargetId: 'ssh-1' },
        0,
        3
      )
    ).rejects.toThrow('host changes')
    await expect(
      statRuntimeReadTarget({
        ...localArgs,
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        relativePath: '/other/large.csv'
      })
    ).rejects.toThrow('outside')
    expect(fsReadFileChunk).not.toHaveBeenCalled()
    expect(fsStat).not.toHaveBeenCalled()
  })
  it('asks old hosts to update without attempting a whole-file fallback', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'chunk',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' }
    })
    await expect(
      readRuntimeFileRange(
        { ...localArgs, settings: { activeRuntimeEnvironmentId: 'env-1' } },
        0,
        3
      )
    ).rejects.toThrow('newer Orca server')
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(fsReadFileChunk).not.toHaveBeenCalled()
  })
  it('rejects invalid requests and corrupt or stalled responses', async () => {
    await expect(readRuntimeFileRange(localArgs, -1, 3)).rejects.toThrow('position')
    await expect(readRuntimeFileRange(localArgs, 0, 256 * 1024 + 1)).rejects.toThrow('limit')
    expect(fsReadFileChunk).not.toHaveBeenCalled()
    for (const result of [
      { contentBase64: '', bytesRead: 0 },
      { contentBase64: 'YWJj', bytesRead: 2 },
      { contentBase64: 'YWJj', bytesRead: 3 }
    ]) {
      fsReadFileChunk.mockResolvedValue(result)
      await expect(readRuntimeFileRange(localArgs, 0, 2)).rejects.toThrow('invalid CSV chunk')
    }
  })
})

describe('CSV file admission', () => {
  it('never reads a large CSV into the editable content cache', async () => {
    fsStat.mockResolvedValue(snapshot)
    expect(await readEditorCsvFileContent(localArgs)).toEqual({
      content: '',
      isBinary: false,
      csvPreview: { readArgs: localArgs, snapshot }
    })
    expect(fsReadFile).not.toHaveBeenCalled()
  })
  it('keeps small files editable and preserves existing dirty drafts', async () => {
    fsStat.mockResolvedValue({ ...snapshot, size: CSV_PAGED_PREVIEW_BYTES - 1 })
    fsReadFile.mockResolvedValue({ content: 'a,b\n1,2', isBinary: false })
    expect((await readEditorCsvFileContent(localArgs)).csvPreview).toBeUndefined()
    fsStat.mockClear()
    await readEditorCsvFileContent(localArgs, false)
    expect(fsStat).not.toHaveBeenCalled()
    expect(fsReadFile).toHaveBeenCalledTimes(2)
  })
})
