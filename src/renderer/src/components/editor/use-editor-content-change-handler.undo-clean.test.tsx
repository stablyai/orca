// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { useEditorContentChangeHandler } from './use-editor-content-change-handler'

const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('@/store', () => {
  const read = () => {
    if (!storeRef.current) {
      throw new Error('store not set')
    }
    return storeRef.current.getState()
  }
  const useAppStore = Object.assign(
    <T,>(select: (state: ReturnType<typeof read>) => T): T => select(read()),
    { getState: read }
  )
  return { useAppStore }
})

afterEach(cleanup)

it('drops the draft when an edit is undone back to the saved text, so a clean tab holds none', () => {
  const store = createEditorStore()
  storeRef.current = store
  store.getState().openFile({
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  const file = store.getState().openFiles[0]
  const { result } = renderHook(() =>
    useEditorContentChangeHandler({
      fileContents: { [file.id]: { content: 'saved', isBinary: false } },
      diffContents: {}
    })
  )

  act(() => result.current(file, 'saved typed'))
  expect(store.getState().editorDrafts[file.id]).toBe('saved typed')
  expect(store.getState().openFiles[0]?.isDirty).toBe(true)

  act(() => result.current(file, 'saved'))
  expect(store.getState().openFiles[0]?.isDirty).toBe(false)
  expect(store.getState().editorDrafts[file.id]).toBeUndefined()
})
