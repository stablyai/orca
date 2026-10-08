import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeFileClient from '@/runtime/runtime-file-client'
import type * as EditorAutosave from '@/components/editor/editor-autosave'

const mocks = vi.hoisted(() => ({ renameRuntimePath: vi.fn(), writeRuntimeFile: vi.fn() }))
vi.mock('@/runtime/runtime-file-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeFileClient>()
  return {
    ...actual,
    renameRuntimePath: mocks.renameRuntimePath,
    writeRuntimeFile: mocks.writeRuntimeFile
  }
})
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorAutosave>()
  return { ...actual, requestEditorSaveQuiesce: vi.fn().mockResolvedValue(undefined) }
})

import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  clearFileExplorerUndoHistory,
  redoFileExplorer,
  undoFileExplorer
} from '@/components/right-sidebar/fileExplorerUndoRedo'
import { createEditorSaveQueue } from '@/components/editor/editor-save-queue'
import { editorTabDocumentFolderAccess, editorTabFileAccess } from './local-file-access'
import { renameFileOnDisk } from './rename-file'

const PROJECT = '/Users/me/project'
const WT = `repo-local::${PROJECT}`
const repo: Repo = {
  id: 'repo-local',
  path: PROJECT,
  displayName: 'project',
  badgeColor: '#000',
  addedAt: 0
}
const worktree: Worktree = {
  id: WT,
  repoId: 'repo-local',
  path: PROJECT,
  head: 'a',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true,
  displayName: 'project',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

const documentFolder = (documentPath: string) => ({ kind: 'document-folder', documentPath })

function openUserNamedTab(filePath: string, worktreeId: string): void {
  useAppStore.getState().openFile(
    {
      filePath,
      relativePath: filePath,
      worktreeId,
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

function onlyTab() {
  const tabs = useAppStore.getState().openFiles
  expect(tabs).toHaveLength(1)
  return tabs[0]!
}

// Why each check: reads and the next rename/image insert derive access from the tab, and a restart
// restores the same filePath/relativePath, so access must survive on the stored fields alone.
async function expectUserNamedAt(filePath: string): Promise<void> {
  const tab = onlyTab()
  expect(tab.filePath).toBe(filePath)
  expect(tab.relativePath).toBe(filePath)
  const state = useAppStore.getState()
  expect(editorTabFileAccess(state, tab)).toEqual({ kind: 'user-file' })
  expect(editorTabDocumentFolderAccess(state, tab)).toEqual(documentFolder(filePath))
  const restored = {
    filePath: tab.filePath,
    relativePath: tab.relativePath,
    worktreeId: tab.worktreeId,
    runtimeEnvironmentId: tab.runtimeEnvironmentId
  }
  expect(editorTabFileAccess(state, restored)).toEqual({ kind: 'user-file' })

  mocks.writeRuntimeFile.mockClear()
  await createEditorSaveQueue(useAppStore).queueSave(tab, 'edited', 'user')
  expect(mocks.writeRuntimeFile).toHaveBeenCalledWith(expect.anything(), filePath, 'edited', {
    kind: 'user-file'
  })
}

async function renameTab(newName: string, worktreePath: string): Promise<void> {
  const tab = onlyTab()
  await renameFileOnDisk({
    oldPath: tab.filePath,
    newName,
    worktreeId: tab.worktreeId,
    worktreePath,
    operationOwner: { kind: 'local' },
    documentScoped: editorTabDocumentFolderAccess(useAppStore.getState(), tab) !== undefined
  })
}

function renameCalls(): unknown[][] {
  return mocks.renameRuntimePath.mock.calls.map((call) => call.slice(1))
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ repos: [repo], worktreesByRepo: { 'repo-local': [worktree] } })
  clearFileExplorerUndoHistory()
  mocks.renameRuntimePath.mockReset().mockResolvedValue(undefined)
  mocks.writeRuntimeFile.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    dispatchEvent: vi.fn()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renaming a floating-workspace document, then Undo and Redo', () => {
  const NOTE = '/home/me/notes/note.md'

  // Why the moved file is the document on Undo: main widens a rename only from the opened document.
  it.each([
    ['another outside folder', '../other/note.md', '/home/me/notes/../other/note.md'],
    [
      'a project',
      '../../../Users/me/project/note.md',
      '/home/me/notes/../../../Users/me/project/note.md'
    ],
    ['a subfolder', 'archive/note.md', '/home/me/notes/archive/note.md']
  ])('moves it into %s and keeps it user-named', async (_, newName, moved) => {
    openUserNamedTab(NOTE, FLOATING_TERMINAL_WORKTREE_ID)

    await renameTab(newName, '/home/me/notes')
    await expectUserNamedAt(moved)
    expect(await undoFileExplorer()).toBe(true)
    await expectUserNamedAt(NOTE)
    expect(await redoFileExplorer()).toBe(true)
    await expectUserNamedAt(moved)

    expect(renameCalls()).toEqual([
      [NOTE, moved, documentFolder(NOTE)],
      [moved, NOTE, documentFolder(moved)],
      [NOTE, moved, documentFolder(NOTE)]
    ])
  })
})

describe('renaming a tab opened by its full path in a project workspace', () => {
  it.each([
    ['to another outside name', '/tmp/notes.md', 'notes2.md', '/tmp/notes2.md'],
    ['into its own project', '/Users/me/notes.md', 'project/notes.md', `${PROJECT}/notes.md`],
    [
      'out of its own project',
      `${PROJECT}/docs/plan.md`,
      '../../plan.md',
      `${PROJECT}/docs/../../plan.md`
    ]
  ])('keeps it user-named %s, after Undo too', async (_, original, newName, moved) => {
    openUserNamedTab(original, WT)

    await renameTab(newName, PROJECT)
    await expectUserNamedAt(moved)
    expect(await undoFileExplorer()).toBe(true)
    await expectUserNamedAt(original)

    expect(renameCalls()).toEqual([
      [original, moved, documentFolder(original)],
      [moved, original, documentFolder(moved)]
    ])
  })

  it('keeps a full-path tab user-named when its project folder is moved', async () => {
    const link = `${PROJECT}/docs/link.md`
    openUserNamedTab(link, WT)

    await renameFileOnDisk({
      oldPath: `${PROJECT}/docs`,
      newName: 'notes',
      worktreeId: WT,
      worktreePath: PROJECT,
      operationOwner: { kind: 'local' }
    })

    await expectUserNamedAt(`${PROJECT}/notes/link.md`)
    expect(renameCalls()).toEqual([[`${PROJECT}/docs`, `${PROJECT}/notes`, undefined]])
  })

  it('still recomputes a project tab project-relative, with no declared access', async () => {
    useAppStore.getState().openFile(
      {
        filePath: `${PROJECT}/docs/plan.md`,
        relativePath: 'docs/plan.md',
        worktreeId: WT,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    await renameTab('plan2.md', PROJECT)

    const tab = onlyTab()
    expect(tab.relativePath).toBe('docs/plan2.md')
    expect(editorTabFileAccess(useAppStore.getState(), tab)).toBeUndefined()
    expect(renameCalls()).toEqual([
      [`${PROJECT}/docs/plan.md`, `${PROJECT}/docs/plan2.md`, undefined]
    ])
  })
})
