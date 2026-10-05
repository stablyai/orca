// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore, makeWorktree } from '@/store/slices/store-test-helpers'
import type { OpenFile } from '@/store/slices/editor'
import { editorSelectionCache, scrollTopCache } from '@/lib/scroll-cache'
import { getDefaultSettings } from '../../../../shared/constants'

const testState = vi.hoisted(() => {
  const state: { store: ReturnType<typeof createTestStore> | null } = { store: null }
  return state
})

vi.mock('@/store', () => {
  const getStore = () => {
    if (!testState.store) {
      throw new Error('Missing test store')
    }
    return testState.store
  }
  return {
    useAppStore: Object.assign((selector: (state: AppState) => unknown) => getStore()(selector), {
      getState: () => getStore().getState()
    })
  }
})
vi.mock('@/lib/monaco-setup', async () => {
  const { loader } = await import('@monaco-editor/react')
  loader.config({ monaco })
  return {}
})
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: vi.fn(), toastNode: null })
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({
  useDiffCommentDecorator: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() }
}))

import MonacoEditor from './MonacoEditor'

const originalGetContext = HTMLCanvasElement.prototype.getContext
let creationListener: monaco.IDisposable | null = null

afterEach(() => {
  cleanup()
  creationListener?.dispose()
  creationListener = null
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
  editorSelectionCache.clear()
  scrollTopCache.clear()
  Reflect.set(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
  testState.store = null
})

it('preserves a draft, selected range and scroll when the same tab gains a known owner', async () => {
  // Only text metrics are needed; this test does not inspect canvas painting.
  Reflect.set(HTMLCanvasElement.prototype, 'getContext', () => ({
    webkitBackingStorePixelRatio: 1,
    measureText: (value: string) => ({ width: value.length * 8 }),
    fillRect: () => {},
    clearRect: () => {},
    fillText: () => {},
    setTransform: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4)
    }),
    getImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4)
    }),
    putImageData: () => {}
  }))
  const store = createTestStore()
  testState.store = store
  const file: OpenFile = {
    id: 'restored-file',
    worktreeId: 'pending-workspace',
    filePath: '/repo/restored.txt',
    relativePath: 'restored.txt',
    mode: 'edit',
    language: 'plaintext',
    isDirty: true
  }
  store.setState({
    openFiles: [file],
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    settings: { ...getDefaultSettings('/fixture'), theme: 'dark', editorWordWrap: false }
  })
  const widgets: monaco.editor.ICodeEditor[] = []
  creationListener = monaco.editor.onDidCreateEditor((instance) => widgets.push(instance))
  const props = {
    fileId: file.id,
    filePath: file.filePath,
    viewStateKey: 'pane:restored-file',
    relativePath: file.relativePath,
    language: file.language,
    content: Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n'),
    onContentChange: vi.fn(),
    onSave: vi.fn()
  }
  const rendered = render(<MonacoEditor {...props} />)
  await waitFor(() => expect(widgets).toHaveLength(1))
  const before = widgets[0]
  if (!before) {
    throw new Error('Missing initial editor')
  }
  const originalModel = before.getModel()
  if (!originalModel) {
    throw new Error('Missing original model')
  }
  const draft = `${props.content}\nunsaved draft`
  rendered.rerender(<MonacoEditor {...props} content={draft} />)
  expect(originalModel.getValue()).toBe(draft)
  expect(originalModel.canUndo()).toBe(true)
  before.layout({ width: 600, height: 300 })
  const selection = new monaco.Selection(80, 2, 82, 5)
  before.setSelection(selection)
  before.setScrollTop(1500)
  expect(before.getScrollTop()).toBe(1500)

  const openFiles = store.getState().openFiles
  act(() => {
    store.setState({
      worktreesByRepo: {
        repo: [
          makeWorktree({ id: file.worktreeId, repoId: 'repo', path: '/repo', hostId: 'local' })
        ]
      }
    })
  })
  expect(store.getState().openFiles).toBe(openFiles)
  await waitFor(() => expect(widgets).toHaveLength(2))
  const after = widgets[1]
  if (!after) {
    throw new Error('Missing resolved editor')
  }
  expect(after.getModel()).not.toBe(originalModel)
  expect(after.getModel()?.getValue()).toBe(draft)
  expect(after.getModel()?.canUndo()).toBe(false)
  await waitFor(() => expect(after.getSelection()?.toString()).toBe(selection.toString()))
  expect(after.getScrollTop()).toBe(1500)
  expect(props.onContentChange).not.toHaveBeenCalled()
  act(() => {
    after.executeEdits('user-edit', [{ range: new monaco.Range(301, 14, 301, 14), text: '!' }])
  })
  await waitFor(() => expect(props.onContentChange).toHaveBeenCalledExactlyOnceWith(`${draft}!`))
})
