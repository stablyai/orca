import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { assertEditorBufferInvariant } from '../../../editor-buffer-record-lifecycle'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import type { OpenFile } from '../types/open-file'

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: 'sig',
    ...patch
  }
}

const view = (id: string) => useAppStore.getState().openFiles.find((file) => file.id === id)

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
})

it('a view with an identical draft merges and mirrors the record as dirty', () => {
  useAppStore.setState({
    openFiles: [tab('a', { isDirty: true })],
    editorDrafts: { a: 'same edits' }
  })
  // The joining view holds the same draft but its own flag reads clean.
  useAppStore.setState((s) => ({
    openFiles: [...s.openFiles, tab('b')],
    editorDrafts: { ...s.editorDrafts, b: 'same edits' }
  }))

  const state = useAppStore.getState()
  expect(state.editorBufferIdOf.b).toBe(state.editorBufferIdOf.a)
  expect(view('b')?.isDirty).toBe(true)
  expect(() => assertEditorBufferInvariant(state)).not.toThrow()
})

it('a clean view that saw the file deleted keeps the deleted banner on every view when it joins', () => {
  useAppStore.setState({ openFiles: [tab('a')] })
  useAppStore.setState((s) => ({
    openFiles: [...s.openFiles, tab('b', { externalMutation: 'deleted' })]
  }))

  const state = useAppStore.getState()
  expect(state.editorBufferIdOf.b).toBe(state.editorBufferIdOf.a)
  expect(view('a')?.externalMutation).toBe('deleted')
  expect(view('b')?.externalMutation).toBe('deleted')
})

it('a deleted banner does not leak onto a dirty target', () => {
  useAppStore.setState({
    openFiles: [tab('a', { isDirty: true })],
    editorDrafts: { a: 'mine' }
  })
  useAppStore.setState((s) => ({
    openFiles: [...s.openFiles, tab('b', { externalMutation: 'deleted' })]
  }))

  expect(view('a')?.externalMutation).toBeUndefined()
})
