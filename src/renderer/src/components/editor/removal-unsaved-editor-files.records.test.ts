import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { lastViewUnsavedFiles } from './removal-unsaved-editor-files'

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: true,
    mode: 'edit',
    lastKnownDiskSignature: 'sig',
    ...patch
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
})

it('through the real identity index, skips a file whose record keeps a view open', () => {
  useAppStore.setState({ openFiles: [tab('a')], editorDrafts: { a: 'edits' } })
  useAppStore.setState((s) => ({
    openFiles: [...s.openFiles, tab('b')],
    editorDrafts: { ...s.editorDrafts, b: 'edits' }
  }))
  const state = useAppStore.getState()
  expect(state.editorBufferIdOf.a).toBe(state.editorBufferIdOf.b)

  expect(lastViewUnsavedFiles(state, new Set(['a']))).toEqual([])
  expect(lastViewUnsavedFiles(state, new Set(['a', 'b']))).toHaveLength(1)
})
