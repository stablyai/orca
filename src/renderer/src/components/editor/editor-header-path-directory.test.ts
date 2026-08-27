import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

const readRuntimeDirectory = vi.hoisted(() => vi.fn())
const getEditorFileOperationContext = vi.hoisted(() => vi.fn())
const getState = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeDirectory: (...args: unknown[]) => readRuntimeDirectory(...args)
}))
vi.mock('@/lib/editor-file-operation-owner', () => ({
  getEditorFileOperationContext: (...args: unknown[]) => getEditorFileOperationContext(...args)
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => getState() }
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  joinEditorHeaderPathEntry,
  listEditorHeaderDirectory,
  openEditorHeaderPathFile
} from './editor-header-path-directory'

const file: Pick<
  OpenFile,
  'mode' | 'worktreeId' | 'runtimeEnvironmentId' | 'externalSshTargetId' | 'operationProvenance'
> = {
  mode: 'edit',
  worktreeId: 'wt-1'
}

const activateTab = vi.fn()

describe('listEditorHeaderDirectory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getState.mockReturnValue({
      settings: {},
      openFiles: [],
      unifiedTabsByWorktree: {},
      activateTab
    })
    getEditorFileOperationContext.mockReturnValue({
      settings: {},
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      expectedExecutionHostId: 'local'
    })
  })

  it('filters hidden tree entries and sorts folders first', async () => {
    readRuntimeDirectory.mockResolvedValueOnce([
      { name: 'z.ts', isDirectory: false, isSymlink: false },
      { name: '.git', isDirectory: true, isSymlink: false },
      { name: 'node_modules', isDirectory: true, isSymlink: false },
      { name: '10 - dir', isDirectory: true, isSymlink: false },
      { name: '9 - a.ts', isDirectory: false, isSymlink: false }
    ])

    await expect(listEditorHeaderDirectory(file, '/repo', '/repo/src')).resolves.toEqual({
      status: 'ok',
      entries: [
        { name: '10 - dir', isDirectory: true, isSymlink: false },
        { name: '9 - a.ts', isDirectory: false, isSymlink: false },
        { name: 'z.ts', isDirectory: false, isSymlink: false }
      ]
    })
    expect(readRuntimeDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1', worktreePath: '/repo' }),
      '/repo/src'
    )
  })

  it('returns a visible listing error instead of throwing', async () => {
    readRuntimeDirectory.mockRejectedValueOnce(new Error('EACCES'))
    await expect(listEditorHeaderDirectory(file, '/repo', '/repo/src')).resolves.toEqual({
      status: 'error',
      message: 'EACCES'
    })
  })

  it('passes the open file owner into the existing readDir route', async () => {
    const sshFile = {
      ...file,
      runtimeEnvironmentId: 'env-1',
      externalSshTargetId: 'ssh-1'
    }
    readRuntimeDirectory.mockResolvedValueOnce([])
    await listEditorHeaderDirectory(sshFile, '/remote/repo', '/remote/repo/src')
    expect(getEditorFileOperationContext).toHaveBeenCalledWith(
      expect.anything(),
      sshFile,
      '/remote/repo'
    )
    expect(readRuntimeDirectory).toHaveBeenCalledWith(expect.anything(), '/remote/repo/src')
  })

  it('surfaces owner-resolution failures in the listing', async () => {
    getEditorFileOperationContext.mockImplementationOnce(() => {
      throw new Error("Couldn't verify which host owns this file.")
    })
    await expect(listEditorHeaderDirectory(file, '/repo', '/repo/src')).resolves.toEqual({
      status: 'error',
      message: "Couldn't verify which host owns this file."
    })
  })
})

describe('openEditorHeaderPathFile', () => {
  it('opens an ordinary file in the current group', () => {
    const openFile = vi.fn()
    const openMarkdownPreview = vi.fn()
    const target = joinEditorHeaderPathEntry('/repo/src/lib', 'src/lib', 'other.ts')

    openEditorHeaderPathFile({
      currentFile: file,
      ...target,
      targetGroupId: 'group-1',
      openFile,
      openMarkdownPreview
    })

    expect(openMarkdownPreview).not.toHaveBeenCalled()
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/src/lib/other.ts',
        relativePath: 'src/lib/other.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      }),
      { targetGroupId: 'group-1' }
    )
  })

  it('keeps markdown preview when the current tab is a preview of markdown', () => {
    const openFile = vi.fn()
    const openMarkdownPreview = vi.fn()
    const target = joinEditorHeaderPathEntry('/repo/docs', 'docs', 'guide.md')

    openEditorHeaderPathFile({
      currentFile: { ...file, mode: 'markdown-preview' },
      ...target,
      targetGroupId: 'group-1',
      openFile,
      openMarkdownPreview
    })

    expect(openFile).not.toHaveBeenCalled()
    expect(openMarkdownPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/docs/guide.md',
        relativePath: 'docs/guide.md',
        language: 'markdown',
        worktreeId: 'wt-1'
      }),
      { targetGroupId: 'group-1' }
    )
  })

  it.each([
    ['edit' as const, '/repo/src/lib/other.ts', 'other.ts'],
    ['markdown-preview' as const, '/repo/docs/guide.md', 'guide.md']
  ])('activates an existing %s tab in another split group', (mode, filePath, name) => {
    const existingId = mode === 'edit' ? filePath : `markdown-preview::${filePath}`
    getState.mockReturnValue({
      settings: {},
      openFiles: [
        {
          id: existingId,
          filePath,
          relativePath: name,
          worktreeId: 'wt-1',
          language: mode === 'edit' ? 'typescript' : 'markdown',
          isDirty: false,
          mode
        }
      ],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-existing',
            entityId: existingId,
            groupId: 'group-2',
            contentType: 'editor'
          }
        ]
      },
      activateTab
    })
    const openFile = vi.fn()
    const openMarkdownPreview = vi.fn()

    openEditorHeaderPathFile({
      currentFile: { ...file, mode },
      filePath,
      relativePath: name,
      targetGroupId: 'group-1',
      openFile,
      openMarkdownPreview
    })

    expect(activateTab).toHaveBeenCalledWith('unified-existing')
    const opener = mode === 'edit' ? openFile : openMarkdownPreview
    expect(opener).toHaveBeenCalledWith(expect.anything(), { targetGroupId: 'group-2' })
  })
})
