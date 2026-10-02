// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, expect, it, vi } from 'vitest'
import {
  attachModelLifetimeView,
  createModelLifetimeFixture,
  modelLifetimeFile,
  modelLifetimeTextModel,
  modelLifetimeEditorModel,
  resetModelLifetimeFixtures
} from './editor-model-lifetime-fixture'
import { getDiffViewerMonacoModelPaths } from './diff-monaco-model-disposal'
import { scrollTopCache, pdfViewPositionCache } from '@/lib/scroll-cache'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
afterEach(resetModelLifetimeFixtures)

it('does not replay earlier model-disposal authority after first registry registration', async () => {
  const { store, bridge, attach } = createModelLifetimeFixture(false)
  const file = modelLifetimeFile('unloaded')
  attach()
  store.setState({ openFiles: [file] })
  store.getState().closeFile(file.id)
  const model = modelLifetimeEditorModel(file.filePath)
  const unregister = bridge.register(monaco)
  try {
    await Promise.resolve()
    expect(model.isDisposed()).toBe(false)
    store.setState({ openFiles: [file] })
    store.getState().closeFile(file.id)
    await Promise.resolve()
    expect(model.isDisposed()).toBe(true)
  } finally {
    unregister()
  }
})

it('does not let a stale HMR unregister clear a successor registration', async () => {
  const { store, bridge, attach, add } = createModelLifetimeFixture(false)
  const unregisterOld = bridge.register(monaco)
  attach()
  const unregisterNew = bridge.register(monaco)
  unregisterOld()
  try {
    expect(bridge.get()).toBe(monaco)
    const { file, model } = add('hmr-successor')
    store.getState().closeFile(file.id)
    await Promise.resolve()
    expect(model.isDisposed()).toBe(true)
  } finally {
    unregisterNew()
  }
})

it('releases generated closed diff namespaces after detachment and preserves sibling prefixes', async () => {
  const { store, attach } = createModelLifetimeFixture()
  const file = modelLifetimeFile('diff-a', 'diff')
  const sibling = modelLifetimeFile('diff-a-longer', 'diff')
  const paths = getDiffViewerMonacoModelPaths({
    modelKey: file.id,
    generationSuffix: ':large-diff-generation:2'
  })
  const siblingPaths = getDiffViewerMonacoModelPaths({
    modelKey: sibling.id,
    generationSuffix: ''
  })
  const original = modelLifetimeTextModel(paths.originalModelPath)
  const modified = modelLifetimeTextModel(paths.modifiedModelPath)
  const live = modelLifetimeTextModel(siblingPaths.originalModelPath)
  const detachView = attachModelLifetimeView(original)
  store.setState({ openFiles: [file, sibling] })
  attach()
  store.getState().closeFile(file.id)
  await Promise.resolve()
  expect(original.isDisposed()).toBe(false)
  expect(modified.isDisposed()).toBe(true)
  expect(live.isDisposed()).toBe(false)
  detachView()
  expect(original.isDisposed()).toBe(false)
  await Promise.resolve()
  expect(original.isDisposed()).toBe(true)
  expect(live.isDisposed()).toBe(false)
})

it('preserves bounded cold-registry rich, preview and PDF caches without loading Monaco', async () => {
  const { store, attach } = createModelLifetimeFixture(false)
  const file = modelLifetimeFile('cold-rich')
  const preview = modelLifetimeFile('cold-preview', 'markdown-preview')
  const sibling = modelLifetimeFile('cold-live')
  store.setState({ openFiles: [file, preview, sibling] })
  attach()
  scrollTopCache.set(`${file.filePath}:rich`, 10)
  scrollTopCache.set(`${file.filePath}::pane`, 11)
  scrollTopCache.set(`${preview.id}:preview`, 12)
  scrollTopCache.set(`${preview.id}::pane`, 13)
  scrollTopCache.set(`${sibling.filePath}:rich`, 14)
  const position = { pageNumber: 2, top: 3, left: 4 }
  pdfViewPositionCache.set(`${file.filePath}:pdf`, position)
  pdfViewPositionCache.set(`${file.filePath}::pane:pdf`, position)
  pdfViewPositionCache.set(`${sibling.filePath}:pdf`, position)
  store.getState().closeFile(file.id)
  store.getState().closeFile(preview.id)
  await Promise.resolve()
  expect([...scrollTopCache]).toEqual([
    [`${file.filePath}:rich`, 10],
    [`${file.filePath}::pane`, 11],
    [`${preview.id}:preview`, 12],
    [`${preview.id}::pane`, 13],
    [`${sibling.filePath}:rich`, 14]
  ])
  expect([...pdfViewPositionCache]).toEqual([
    [`${file.filePath}:pdf`, position],
    [`${file.filePath}::pane:pdf`, position],
    [`${sibling.filePath}:pdf`, position]
  ])
})

it('preserves queued model custody across registry removal and replacement', async () => {
  const { store, bridge, attach, add } = createModelLifetimeFixture(false)
  const unregister = bridge.register(monaco)
  const { file, model } = add('queued-replacement')
  attach()
  store.getState().closeFile(file.id)
  unregister()
  await Promise.resolve()
  expect(model.isDisposed()).toBe(false)
  const unregisterNext = bridge.register(monaco)
  try {
    await Promise.resolve()
    expect(model.isDisposed()).toBe(true)
  } finally {
    unregisterNext()
  }
})

it('preserves retained attachment custody across registry replacement', async () => {
  const { store, bridge, attach, add } = createModelLifetimeFixture(false)
  const unregister = bridge.register(monaco)
  const { file, model } = add('attached-replacement')
  const detachView = attachModelLifetimeView(model)
  attach()
  store.getState().closeFile(file.id)
  await Promise.resolve()
  unregister()
  detachView()
  await Promise.resolve()
  expect(model.isDisposed()).toBe(false)
  const unregisterNext = bridge.register(monaco)
  try {
    await Promise.resolve()
    expect(model.isDisposed()).toBe(true)
  } finally {
    unregisterNext()
  }
})

it('preserves successor models at a captured URI across registry replacement', async () => {
  const { store, bridge, attach, add } = createModelLifetimeFixture(false)
  const unregister = bridge.register(monaco)
  const { file, model } = add('successor-replacement')
  attach()
  store.getState().closeFile(file.id)
  unregister()
  model.dispose()
  const successor = modelLifetimeEditorModel(file.filePath)
  const unregisterNext = bridge.register(monaco)
  try {
    await Promise.resolve()
    expect(successor.isDisposed()).toBe(false)
  } finally {
    unregisterNext()
  }
})

it('retries the remaining captured batch after reentrant registry replacement', async () => {
  const { store, bridge, attach, add } = createModelLifetimeFixture()
  const first = add('reentrant-registry-first')
  const second = add('reentrant-registry-second')
  attach()
  let unregisterNext: (() => void) | undefined
  const replaceRegistry = first.model.onWillDispose(() => {
    unregisterNext = bridge.register(monaco)
  })
  try {
    store.getState().closeAllFiles()
    await Promise.resolve()
    await Promise.resolve()
    expect(first.model.isDisposed()).toBe(true)
    expect(second.model.isDisposed()).toBe(true)
  } finally {
    replaceRegistry.dispose()
    unregisterNext?.()
  }
})
