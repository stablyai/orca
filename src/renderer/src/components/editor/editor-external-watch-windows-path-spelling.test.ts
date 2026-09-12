import { describe, expect, it } from 'vitest'
import { win32 as winPath } from 'node:path'
import type { OpenFile } from '@/store/slices/editor'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import { indexEditorExternalWatchBatchPaths } from './editor-external-watch-path-index'
import { getOpenFilesForExternalFileChange } from './editor-autosave'

const WORKTREE_ID = 'wt-windows'
// The watch root as the store holds it, and the same root as a Windows tool spells it back.
const STORE_ROOT = 'C:/Users/dev/repo'
const AGENT_ROOT = winPath.join('c:\\Users\\dev\\repo')

function editorTab(filePath: string): OpenFile {
  return {
    id: 'tab-1',
    filePath,
    relativePath: 'src/index.ts',
    worktreeId: WORKTREE_ID,
    mode: 'edit',
    isDirty: false,
    content: '',
    language: 'typescript'
  } as unknown as OpenFile
}

function updatePayload(absolutePath: string): FsChangedPayload {
  return {
    worktreePath: STORE_ROOT,
    events: [{ kind: 'update', absolutePath, isDirectory: false }]
  } as unknown as FsChangedPayload
}

describe('external watch matching across Windows path spellings', () => {
  it('matches an open tab whose filePath differs only by separator and drive case', () => {
    const tab = editorTab(winPath.join(AGENT_ROOT, 'src', 'index.ts'))
    const index = indexEditorExternalWatchBatchPaths(
      updatePayload(winPath.join(AGENT_ROOT, 'src', 'index.ts')),
      [tab],
      { worktreeId: WORKTREE_ID, worktreePath: STORE_ROOT, runtimeEnvironmentId: null }
    )

    expect(index.changes).toHaveLength(1)
    expect(index.matchingOpenFiles(index.changes[0])).toEqual([tab])
  })

  it('matches without the batch index, on the notification fallback path', () => {
    const tab = editorTab(winPath.join(AGENT_ROOT, 'src', 'index.ts'))

    expect(
      getOpenFilesForExternalFileChange([tab], {
        worktreeId: WORKTREE_ID,
        worktreePath: STORE_ROOT,
        relativePath: 'src/index.ts',
        runtimeEnvironmentId: null
      })
    ).toEqual([tab])
  })

  it('still rejects a sibling file under the same root', () => {
    const tab = editorTab(winPath.join(AGENT_ROOT, 'src', 'index.ts'))
    const index = indexEditorExternalWatchBatchPaths(
      updatePayload(winPath.join(AGENT_ROOT, 'src', 'other.ts')),
      [tab],
      { worktreeId: WORKTREE_ID, worktreePath: STORE_ROOT, runtimeEnvironmentId: null }
    )

    expect(index.matchingOpenFiles(index.changes[0])).toEqual([])
  })

  it('does not fold case for a POSIX root, where names are distinct files', () => {
    const posixRoot = '/home/dev/repo'
    const tab = {
      ...editorTab('/home/dev/repo/src/Index.ts'),
      relativePath: 'src/Index.ts'
    }
    const index = indexEditorExternalWatchBatchPaths(
      {
        worktreePath: posixRoot,
        events: [{ kind: 'update', absolutePath: '/home/dev/repo/src/index.ts', isDirectory: false }]
      } as unknown as FsChangedPayload,
      [tab],
      { worktreeId: WORKTREE_ID, worktreePath: posixRoot, runtimeEnvironmentId: null }
    )

    expect(index.matchingOpenFiles(index.changes[0])).toEqual([])
  })
})
