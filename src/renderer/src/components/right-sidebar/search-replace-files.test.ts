import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchFileResult } from '../../../../shared/code-search-types'
import { replaceInSearchFiles, type SearchReplaceContext } from './search-replace-files'
import { compileSearchReplace } from './search-replace-text'
import type { FileExplorerOperationRoute } from './file-explorer-operation-owner'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  notify: vi.fn(),
  quiesce: vi.fn(async () => {}),
  openFiles: new Array<{ filePath: string; isDirty: boolean }>()
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFileContent: mocks.read,
  writeRuntimeFile: mocks.write
}))
vi.mock('@/components/editor/editor-autosave', () => ({
  notifyEditorExternalFileChange: mocks.notify,
  requestEditorSaveQuiesce: mocks.quiesce,
  getOpenFilesForExternalFileChange: (
    openFiles: typeof mocks.openFiles,
    target: { worktreePath: string; relativePath: string }
  ) => openFiles.filter((file) => file.filePath === `${target.worktreePath}/${target.relativePath}`)
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ openFiles: mocks.openFiles }) }
}))

const route: FileExplorerOperationRoute = {
  settings: { activeRuntimeEnvironmentId: null },
  expectedExecutionHostId: 'local'
}

function context(): SearchReplaceContext {
  return {
    worktreeId: 'wt',
    worktreePath: '/repo',
    runtimeEnvironmentId: null,
    guard: { route, assertCurrent: () => route },
    compiled: compileSearchReplace(
      { query: 'old', caseSensitive: true, wholeWord: false, useRegex: false },
      'new',
      false
    )
  }
}

function file(relativePath: string, columns: number[] = [1]): SearchFileResult {
  const matches = columns.map((column) => ({ line: 1, column, matchLength: 3, lineContent: '' }))
  return { filePath: `/repo/${relativePath}`, relativePath, matches }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.openFiles = []
})

describe('replaceInSearchFiles', () => {
  it('writes replaced content, notifies open editors, and skips files with unsaved tabs', async () => {
    mocks.openFiles = [{ filePath: '/repo/dirty.ts', isDirty: true }]
    mocks.read.mockImplementation(async ({ relativePath }: { relativePath: string }) => ({
      content: relativePath === 'b.ts' ? 'old old' : 'old',
      isBinary: false
    }))

    const summary = await replaceInSearchFiles(context(), [
      { fileResult: file('a.ts') },
      { fileResult: file('b.ts', [1, 5]) },
      { fileResult: file('dirty.ts') }
    ])

    expect(summary).toEqual({
      replacedCount: 3,
      replacedFiles: 2,
      dirtyFiles: ['dirty.ts'],
      staleFiles: [],
      notUtf8Files: [],
      failures: []
    })
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt', worktreePath: '/repo' }),
      '/repo/b.ts',
      'new new'
    )
    expect(mocks.write).not.toHaveBeenCalledWith(
      expect.anything(),
      '/repo/dirty.ts',
      expect.anything()
    )
    expect(mocks.notify).toHaveBeenCalledTimes(2)
  })

  it('replaces only the targeted match and reports binary or changed files as stale', async () => {
    mocks.read
      .mockResolvedValueOnce({ content: 'old old', isBinary: false })
      .mockResolvedValueOnce({ content: '', isBinary: true })
      .mockResolvedValueOnce({ content: 'edited since', isBinary: false })

    const summary = await replaceInSearchFiles(context(), [
      { fileResult: file('a.ts', [1, 5]), targets: [{ line: 1, column: 5, matchLength: 3 }] },
      { fileResult: file('image.png') },
      { fileResult: file('c.ts') }
    ])

    expect(summary.replacedCount).toBe(1)
    expect(summary.staleFiles).toEqual(['image.png', 'c.ts'])
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(mocks.write).toHaveBeenCalledWith(expect.anything(), '/repo/a.ts', 'old new')
  })

  it('refuses to rewrite a file that did not decode as UTF-8', async () => {
    mocks.read.mockResolvedValue({ content: 'old caf\uFFFD', isBinary: false })

    const summary = await replaceInSearchFiles(context(), [{ fileResult: file('latin1.txt') }])

    expect(summary.notUtf8Files).toEqual(['latin1.txt'])
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('reports a failed write without writing other files twice', async () => {
    mocks.read.mockResolvedValue({ content: 'old', isBinary: false })
    mocks.write.mockRejectedValueOnce(new Error('permission denied'))

    const summary = await replaceInSearchFiles(context(), [
      { fileResult: file('a.ts') },
      { fileResult: file('b.ts') }
    ])

    expect(summary.failures).toEqual([{ relativePath: 'a.ts', message: 'permission denied' }])
    expect(summary.replacedFiles).toBe(1)
    expect(mocks.write).toHaveBeenCalledTimes(2)
  })
})
