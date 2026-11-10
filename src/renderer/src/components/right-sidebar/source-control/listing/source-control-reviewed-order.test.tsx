// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { diffReviewKey, getReviewedDiffs, setDiffReviewed } from '@/lib/editor/diff-reviewed-files'
import type { FsChangedPayload } from '../../../../../../shared/file-watch/filesystem-change-event'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { useSourceControlFileProjection } from './use-file-projection'

let onChanged: ((payload: FsChangedPayload) => void) | undefined
vi.mock('@/runtime/files/watching/runtime-file-watch-client', () => ({
  subscribeRuntimeFileChanges: async (
    _owner: unknown,
    callback: (payload: FsChangedPayload) => void
  ) => {
    onChanged = callback
    return () => {
      onChanged = undefined
    }
  }
}))
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', () => ({
  statRuntimePath: async () => ({ mtime: 123 }),
  isMissingRuntimePathError: () => false
}))
const entries: GitStatusEntry[] = [
  { path: 'a.ts', status: 'modified', area: 'unstaged', added: 1, removed: 1 },
  { path: 'b.ts', status: 'modified', area: 'unstaged', added: 1, removed: 1 },
  { path: 'c.ts', status: 'modified', area: 'unstaged', added: 1, removed: 1 }
]
const empty = new Set<string>()
const noBranches = []
const submoduleStatus = {}
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each([
  ['/repo', '/repo'],
  ['C:\\repo', 'c:\\REPO']
])(
  'moves viewed rows below unviewed rows, restores alphabetical order on unmark, and resets after file edits at %s',
  async (rootPath, eventRoot) => {
    vi.spyOn(Date, 'now').mockReturnValue(1800000000000)
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      repos: [
        { id: 'repo', path: rootPath, displayName: 'repo', badgeColor: '', addedAt: 1, kind: 'git' }
      ],
      worktreesByRepo: { repo: [makeWorktree({ id: 'wt-1', repoId: 'repo', path: rootPath })] }
    })
    for (const key of getReviewedDiffs().keys()) {
      setDiffReviewed(key, null)
    }
    const owner = getEditorFileReadContext(
      useAppStore.getState(),
      { worktreeId: 'wt-1', runtimeEnvironmentId: null },
      rootPath.startsWith('C:') ? 'c:/REPO' : rootPath
    )
    const key = diffReviewKey(owner, 'a.ts', 'unstaged')
    const record = {
      viewedAt: 1800000000000,
      modifiedTime: 123,
      contentSignature: 'reviewed-content',
      entrySignature: '["modified",null,1,1]'
    }
    const { result } = renderHook(() =>
      useSourceControlFileProjection({
        entries,
        branchEntries: noBranches,
        filterQuery: '',
        sourceControlGroupOrder: ['unstaged', 'staged'],
        activeWorktreeId: 'wt-1',
        worktreePath: rootPath,
        isFolder: false,
        collapsedTreeDirs: empty,
        expandedSubmoduleKeys: empty,
        submoduleStatusByKey: submoduleStatus,
        sourceControlViewMode: 'list',
        collapsedSections: empty
      })
    )
    act(() => setDiffReviewed(key, record))
    expect(result.current.visibleSelectionEntries.map((row) => row.entry.path)).toEqual([
      'b.ts',
      'c.ts',
      'a.ts'
    ])
    act(() => setDiffReviewed(key, null))
    expect(result.current.visibleSelectionEntries.map((row) => row.entry.path)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts'
    ])
    act(() => setDiffReviewed(key, record))
    await act(async () =>
      onChanged?.({
        worktreePath: rootPath,
        events: [{ kind: 'update', absolutePath: eventRoot, isDirectory: true }]
      })
    )
    expect(result.current.visibleSelectionEntries.map((row) => row.entry.path)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts'
    ])
  }
)
