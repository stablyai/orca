import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

function openPreview(worktreeId: string, filePath: string, preview: boolean): string {
  return useAppStore.getState().openFile(
    {
      filePath,
      relativePath: filePath.slice('/repo/'.length),
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    },
    { preview, suppressActiveRuntimeFallback: true }
  )
}

function unifiedTabOf(worktreeId: string, fileId: string) {
  return (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.entityId === fileId
  )
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': ['wt-1', 'wt-2'].map((id) =>
        makeWorktree({ id, repoId: 'repo-1', path: '/repo', hostId: 'local' })
      )
    }
  })
})

it('a preview opened onto a file with unsaved edits opens as a kept tab and survives the next click', () => {
  const a = openPreview('wt-1', '/repo/a.ts', false)
  useAppStore.getState().setEditorDraft(a, 'typed in A')
  useAppStore.getState().markFileDirty(a, true)

  const b = openPreview('wt-2', '/repo/a.ts', true)

  expect(useAppStore.getState().openFiles.find((file) => file.id === b)).toMatchObject({
    isDirty: true,
    isPreview: undefined
  })
  expect(unifiedTabOf('wt-2', b)?.isPreview).toBeFalsy()

  openPreview('wt-2', '/repo/b.ts', true)
  useAppStore.getState().closeFile(a)

  // The only tab holding the edits still has a visible tab, so closing it will prompt.
  expect(unifiedTabOf('wt-2', b)).toBeDefined()
  expect(useAppStore.getState().editorDrafts[b]).toBe('typed in A')
})
