// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { useEditorContentChangeHandler } from './use-editor-content-change-handler'
import { useIpynbDocumentEditing } from './useIpynbDocumentEditing'
import { parseIpynb } from './ipynb-parse'
import { bumpEditorDiscardEpoch } from './editor-discard-epoch'
import { editorBufferIdOfView } from '@/store/slices/editor/buffers/editor-buffer-views'

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

it.each(['rejected', 'discarded', 'reverted', 'acknowledged'] as const)(
  'clears notebook dirty state after pending typing is %s back to disk text',
  (resolution) => {
    vi.useFakeTimers()
    const store = createEditorStore()
    storeRef.current = store
    store.getState().openFile({
      filePath: '/repo/clean.ipynb',
      relativePath: 'clean.ipynb',
      worktreeId: 'wt-1',
      language: 'json',
      mode: 'edit'
    })
    const file = store.getState().openFiles[0]
    const notebookText = (source: string) =>
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [{ id: 'cell', cell_type: 'code', metadata: {}, source: [source], outputs: [] }]
      })
    const saved = notebookText('saved')
    const initial =
      resolution === 'rejected' || resolution === 'acknowledged' ? notebookText('older') : saved
    const hook = renderHook(
      ({ content }: { content: string }) => {
        const onChange = useEditorContentChangeHandler({
          fileContents: { [file.id]: { content: saved, isBinary: false } },
          diffContents: {}
        })
        return useIpynbDocumentEditing({
          fileId: file.id,
          content,
          notebook: parseIpynb(content),
          onContentChange: (next) => onChange(file, next),
          onDirtyStateHint: (dirty) => store.getState().markFileDirty(file.id, dirty),
          onDeactivateEditor: () => {}
        })
      },
      { initialProps: { content: initial } }
    )
    try {
      act(() =>
        hook.result.current.updateCellSource(0, resolution === 'acknowledged' ? 'saved' : 'typing')
      )
      expect(store.getState().openFiles[0]?.isDirty).toBe(true)
      if (resolution === 'discarded') {
        bumpEditorDiscardEpoch(editorBufferIdOfView(store.getState(), file.id))
      } else if (resolution === 'reverted') {
        act(() => hook.result.current.updateCellSource(0, 'saved'))
      } else {
        hook.rerender({ content: saved })
      }
      act(() => vi.advanceTimersByTime(400))
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
      expect(store.getState().editorDrafts[file.id]).toBeUndefined()
      if (resolution !== 'reverted') {
        expect(hook.result.current.sourceDrafts).toEqual({})
      }
    } finally {
      hook.unmount()
      vi.useRealTimers()
    }
  }
)
