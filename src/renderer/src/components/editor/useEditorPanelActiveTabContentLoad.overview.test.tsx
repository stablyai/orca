// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { useEditorPanelActiveTabContentLoad } from './useEditorPanelActiveTabContentLoad'

// The active tab's load is a user act that may start a stopped WSL distro.
const WAKE = { wakeWslDistro: true }

const PATH = '/repo/file.ts'
const ENTRY: GitStatusEntry = {
  path: 'file.ts',
  status: 'modified',
  area: 'unstaged',
  conflictKind: 'both_modified',
  conflictStatus: 'unresolved',
  conflictStatusSource: 'git'
}

const state = () => useAppStore.getState()

function openView(worktreeId: string): OpenFile {
  state().openFile({
    filePath: PATH,
    relativePath: 'file.ts',
    worktreeId,
    language: 'typescript',
    mode: 'edit'
  })
  return state().openFiles.find((file) => file.worktreeId === worktreeId && file.mode === 'edit')!
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
})

afterEach(cleanup)

describe('conflict-review overview loads', () => {
  it('reload under the new id when the borrowed view closes or another opens', () => {
    const view = openView('wt-1')
    state().openConflictReview(
      'wt-2',
      '/repo',
      [{ path: 'file.ts', conflictKind: 'both_modified' }],
      'live-summary'
    )
    const review = state().openFiles.find((file) => file.mode === 'conflict-review')!
    const loadFileContent = vi.fn(async () => {})
    // Why stable inputs: only the store's view changes may rerun the load.
    const gitStatusEntries = [ENTRY]
    const refs = {
      fileContents: {},
      diffContents: {},
      fileReadGenerationRef: { current: {} },
      outstandingFileReadsRef: { current: {} },
      diffReadGenerationRef: { current: {} },
      outstandingDiffReadsRef: { current: {} },
      loadDiffContent: vi.fn(async () => {})
    }
    renderHook(() =>
      useEditorPanelActiveTabContentLoad({
        activeFile: review,
        selectedConflictReviewFile: null,
        isVisible: true,
        isChangesMode: false,
        gitStatusEntries,
        ...refs,
        loadFileContent
      })
    )
    expect(loadFileContent).toHaveBeenLastCalledWith(PATH, view.id, 'wt-1', 'file.ts', WAKE)

    act(() => state().closeFile(view.id))
    expect(loadFileContent).toHaveBeenLastCalledWith(PATH, PATH, 'wt-2', 'file.ts', WAKE)

    let reopened: OpenFile | undefined
    act(() => {
      reopened = openView('wt-1')
    })
    expect(loadFileContent).toHaveBeenLastCalledWith(PATH, reopened!.id, 'wt-1', 'file.ts', WAKE)
    expect(loadFileContent).toHaveBeenCalledTimes(3)
  })
})
