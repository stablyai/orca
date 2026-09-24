// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  createModelLifetimeFixture,
  modelLifetimeFile,
  modelLifetimeTextModel,
  resetModelLifetimeFixtures
} from './editor-model-lifetime-fixture'
import { getDiffViewerMonacoModelPaths } from './diff-monaco-model-disposal'
import {
  scrollTopCache,
  editorSelectionCache,
  diffViewStateCache,
  pdfViewPositionCache
} from '@/lib/scroll-cache'
import * as monaco from 'monaco-editor'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
afterEach(resetModelLifetimeFixtures)

it('protects a later file reopened by an earlier model disposal in the same batch', async () => {
  const { store, attach, add } = createModelLifetimeFixture()
  const first = add('first')
  const second = add('second')
  attach()
  const reopen = first.model.onWillDispose(() => store.setState({ openFiles: [second.file] }))
  try {
    store.getState().closeFile(first.file.id)
    store.getState().closeFile(second.file.id)
    await Promise.resolve()
    expect(first.model.isDisposed()).toBe(true)
    expect(second.model.isDisposed()).toBe(false)
  } finally {
    reopen.dispose()
  }
})

it('preserves new same-URI cache entries installed by a model disposal callback', async () => {
  const { store, attach, add } = createModelLifetimeFixture()
  const { file, model } = add('cache-owner')
  attach()
  const selection = [new monaco.Selection(2, 1, 2, 3)]
  const pdf = { pageNumber: 3, top: 4, left: 5 }
  const reopen = model.onWillDispose(() => {
    store.setState({ openFiles: [{ ...file, id: 'new-cache-owner' }] })
    scrollTopCache.set(file.filePath, 41)
    scrollTopCache.set(`${file.filePath}::pane`, 42)
    editorSelectionCache.set(file.filePath, selection)
    editorSelectionCache.set(`${file.filePath}::pane`, selection)
    pdfViewPositionCache.set(`${file.filePath}:pdf`, pdf)
    pdfViewPositionCache.set(`${file.filePath}::pane:pdf`, pdf)
  })
  try {
    store.getState().closeFile(file.id)
    await Promise.resolve()
    expect(scrollTopCache.get(file.filePath)).toBe(41)
    expect(scrollTopCache.get(`${file.filePath}::pane`)).toBe(42)
    expect(editorSelectionCache.get(file.filePath)).toBe(selection)
    expect(editorSelectionCache.get(`${file.filePath}::pane`)).toBe(selection)
    expect(pdfViewPositionCache.get(`${file.filePath}:pdf`)).toBe(pdf)
    expect(pdfViewPositionCache.get(`${file.filePath}::pane:pdf`)).toBe(pdf)
  } finally {
    reopen.dispose()
  }
})

it('checks model and cache ownership after a diff callback reopens its owner and an earlier edit', async () => {
  const { store, attach, add } = createModelLifetimeFixture()
  const { file: editFile } = add('earlier-edit')
  const diffFile = modelLifetimeFile('diff-reentrant', 'diff')
  const paths = getDiffViewerMonacoModelPaths({ modelKey: diffFile.id, generationSuffix: '' })
  const original = modelLifetimeTextModel(paths.originalModelPath)
  const modified = modelLifetimeTextModel(paths.modifiedModelPath)
  store.setState({ openFiles: [editFile, diffFile] })
  attach()
  const scroll = { scrollTop: 1, scrollLeft: 2 }
  const reopen = original.onWillDispose(() => {
    store.setState({ openFiles: [{ ...editFile, id: 'edit-successor' }, diffFile] })
    scrollTopCache.set(`${editFile.filePath}::pane`, 71)
    scrollTopCache.set(`${diffFile.id}:preview`, 72)
    scrollTopCache.set(`${diffFile.id}::pane`, 73)
    diffViewStateCache.set(diffFile.id, { original: null, modified: null, modelState: scroll })
    diffViewStateCache.set(`${diffFile.id}::pane`, {
      original: null,
      modified: null,
      modelState: scroll
    })
  })
  try {
    store.getState().closeFile(editFile.id)
    store.getState().closeFile(diffFile.id)
    await Promise.resolve()
    expect(original.isDisposed()).toBe(true)
    expect(modified.isDisposed()).toBe(false)
    expect(scrollTopCache.get(`${editFile.filePath}::pane`)).toBe(71)
    expect(scrollTopCache.get(`${diffFile.id}:preview`)).toBe(72)
    expect(scrollTopCache.get(`${diffFile.id}::pane`)).toBe(73)
    expect(diffViewStateCache.get(diffFile.id)?.modelState).toBe(scroll)
    expect(diffViewStateCache.get(`${diffFile.id}::pane`)?.modelState).toBe(scroll)
  } finally {
    reopen.dispose()
  }
})
