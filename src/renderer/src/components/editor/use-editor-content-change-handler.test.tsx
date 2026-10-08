// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { useEditorContentChangeHandler } from './use-editor-content-change-handler'

afterEach(() => {
  cleanup()
  useAppStore.setState({ openFiles: [], editorDrafts: {} })
})

it('does not recreate a draft when a pending editor detaches after its tab was closed', () => {
  useAppStore.getState().openFile({
    filePath: '/repo/closed.csv',
    relativePath: 'closed.csv',
    mode: 'edit',
    language: 'plaintext',
    worktreeId: 'csv-close-test'
  })
  const file = useAppStore
    .getState()
    .openFiles.find((file) => file.filePath === '/repo/closed.csv')!
  const { result } = renderHook(() =>
    useEditorContentChangeHandler({ fileContents: {}, diffContents: {} })
  )
  act(() => useAppStore.getState().closeFile(file.id))
  act(() => result.current(file, 'pending,cell'))
  expect(useAppStore.getState().editorDrafts[file.id]).toBeUndefined()
})

it('retains a pending draft when the tab is still open but its table view detached', () => {
  useAppStore.getState().openFile({
    filePath: '/repo/open.csv',
    relativePath: 'open.csv',
    mode: 'edit',
    language: 'plaintext',
    worktreeId: 'csv-close-test'
  })
  const file = useAppStore.getState().openFiles.find((file) => file.filePath === '/repo/open.csv')!
  const { result } = renderHook(() =>
    useEditorContentChangeHandler({ fileContents: {}, diffContents: {} })
  )
  act(() => result.current(file, 'pending,cell'))
  expect(useAppStore.getState().editorDrafts[file.id]).toBe('pending,cell')
  expect(
    useAppStore.getState().openFiles.find((candidate) => candidate.id === file.id)?.isDirty
  ).toBe(true)
})
