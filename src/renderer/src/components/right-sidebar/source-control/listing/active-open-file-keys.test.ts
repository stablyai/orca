import { expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { isBranchDiffActiveEditor } from './active-open-file-keys'

function editorState(file: Partial<OpenFile>, activeTabType: 'editor' | 'terminal' = 'editor') {
  return {
    activeTabTypeByWorktree: { placement: activeTabType },
    activeFileIdByWorktree: { placement: 'file-1' },
    openFiles: [
      {
        id: 'file-1',
        filePath: '/work/app/src/a.ts',
        relativePath: 'src/a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'diff' as const,
        ...file
      }
    ]
  }
}

it('treats a branch row diff or the branch View all diff of this worktree as the active branch editor', () => {
  expect(isBranchDiffActiveEditor(editorState({ diffSource: 'branch' }), 'placement', 'wt-1')).toBe(
    true
  )
  expect(
    isBranchDiffActiveEditor(editorState({ diffSource: 'combined-branch' }), 'placement', 'wt-1')
  ).toBe(true)
})

it('ignores uncommitted diffs, other worktrees and non-editor tabs', () => {
  expect(
    isBranchDiffActiveEditor(editorState({ diffSource: 'unstaged' }), 'placement', 'wt-1')
  ).toBe(false)
  expect(
    isBranchDiffActiveEditor(
      editorState({ diffSource: 'branch', worktreeId: 'wt-2' }),
      'placement',
      'wt-1'
    )
  ).toBe(false)
  expect(
    isBranchDiffActiveEditor(editorState({ diffSource: 'branch' }, 'terminal'), 'placement', 'wt-1')
  ).toBe(false)
})
