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
import {
  scrollTopCache,
  editorSelectionCache,
  diffViewStateCache,
  pdfViewPositionCache,
  setWithLRU
} from '@/lib/scroll-cache'

import {
  checkDetailsReadingKey,
  checkReadingIntentKey,
  checkReadingLogKey,
  checkReadingOuterKey,
  checkReadingStepsKey
} from './check-details-reading-cache'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
afterEach(resetModelLifetimeFixtures)

it('releases eight distinct last-file models while no editor panel is mounted', async () => {
  const { store, attach, add } = createModelLifetimeFixture()
  attach()
  for (let index = 0; index < 8; index += 1) {
    const { file, model } = add(`last-${index}`)
    store.getState().closeFile(file.id)
    await Promise.resolve()
    expect(store.getState().openFiles).toHaveLength(0)
    expect(model.isDisposed()).toBe(true)
  }
})

it('keeps a live model and releases only its closed sibling', async () => {
  const { store, attach, add } = createModelLifetimeFixture()
  const closed = add('closed')
  const live = add('live')
  attach()
  store.getState().closeFile(closed.file.id)
  await Promise.resolve()
  expect(closed.model.isDisposed()).toBe(true)
  expect(live.model.isDisposed()).toBe(false)
})

it('preserves a shared URI until its final file owner closes', async () => {
  const { store, attach, add } = createModelLifetimeFixture()
  const { file, model } = add('shared-a')
  store.setState({ openFiles: [file, { ...file, id: 'shared-b', readOnly: true }] })
  attach()
  store.getState().closeFile(file.id)
  await Promise.resolve()
  expect(store.getState().openFiles.map((openFile) => openFile.id)).toEqual(['shared-b'])
  expect(model.isDisposed()).toBe(false)
  store.getState().closeFile('shared-b')
  await Promise.resolve()
  expect(model.isDisposed()).toBe(true)
})

it('waits beyond the real detach stack and preserves its bounded scroll snapshot', async () => {
  const { store, attach, add } = createModelLifetimeFixture()
  const { file, model } = add('attached')
  const detachView = attachModelLifetimeView(model)
  attach()
  store.getState().closeFile(file.id)
  await Promise.resolve()
  expect(model.isDisposed()).toBe(false)
  scrollTopCache.set(file.filePath, 42)
  detachView()
  expect(model.isDisposed()).toBe(false)
  await Promise.resolve()
  expect(model.isDisposed()).toBe(true)
  expect(scrollTopCache.get(file.filePath)).toBe(42)
})

it('protects a reopened URI owner from a pending detach callback', async () => {
  const { store, attach, add } = createModelLifetimeFixture()
  const { file, model } = add('reopened-old')
  const detachView = attachModelLifetimeView(model)
  attach()
  store.getState().closeFile(file.id)
  await Promise.resolve()
  store.setState({ openFiles: [{ ...file, id: 'reopened-new' }] })
  detachView()
  await Promise.resolve()
  expect(model.isDisposed()).toBe(false)
  store.getState().closeFile('reopened-new')
  await Promise.resolve()
  expect(model.isDisposed()).toBe(true)
})

it('does not dispose a replacement model at an older queued URI', async () => {
  const { store, attach, add } = createModelLifetimeFixture()
  const { file, model } = add('replacement')
  attach()
  store.getState().closeFile(file.id)
  model.dispose()
  const successor = modelLifetimeEditorModel(file.filePath, 'successor')
  await Promise.resolve()
  expect(successor.isDisposed()).toBe(false)
})

it('does not enumerate the global model registry for an ordinary edit close', async () => {
  const { store, attach, add } = createModelLifetimeFixture()
  const { file, model } = add('direct-lookup')
  attach()
  const enumeration = vi.spyOn(monaco.editor, 'getModels')
  store.getState().closeFile(file.id)
  await Promise.resolve()
  expect(model.isDisposed()).toBe(true)
  expect(enumeration).not.toHaveBeenCalled()
})

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

function seed(id: string): void {
  const owner = checkDetailsReadingKey(id, 'pane', 'context')
  for (const key of [
    checkReadingOuterKey(owner),
    checkReadingLogKey(owner, 'job', 'digest'),
    checkReadingStepsKey(owner, 'job', true),
    checkReadingIntentKey(owner, 'job'),
    `${checkDetailsReadingKey(id, null, 'context')}::first-payload`
  ]) {
    setWithLRU(scrollTopCache, key, 10)
  }
}

it.each([false, true])(
  'sweeps closed check details through the live attach controller, Monaco=%s',
  async (registered) => {
    const { store, attach } = createModelLifetimeFixture(registered)
    const closed = modelLifetimeFile('closed-check', 'check-details')
    const live = modelLifetimeFile('live-check', 'check-details')
    const ordinary = modelLifetimeFile('ordinary')
    store.setState({ openFiles: [closed, live, ordinary] })
    attach()
    seed(closed.id)
    seed(live.id)
    setWithLRU(scrollTopCache, ordinary.filePath, 320)
    store.getState().closeFile(closed.id)
    await Promise.resolve()
    expect([...scrollTopCache.keys()].some((key) => key.startsWith(`${closed.id}::`))).toBe(false)
    expect([...scrollTopCache.keys()].some((key) => key.startsWith(`${live.id}::`))).toBe(true)
    store.getState().closeFile(ordinary.id)
    await Promise.resolve()
    expect(scrollTopCache.get(ordinary.filePath)).toBe(320)
  }
)

it('sweeps never-mounted close-all and same-ID mode replacements without Monaco', async () => {
  const { store, attach } = createModelLifetimeFixture(false)
  const a = modelLifetimeFile('never-a', 'check-details')
  const b = modelLifetimeFile('never-b', 'check-details')
  store.setState({ openFiles: [a, b] })
  attach()
  seed(a.id)
  seed(b.id)
  store.setState({ openFiles: [{ ...a, mode: 'edit' }, b] })
  await Promise.resolve()
  expect([...scrollTopCache.keys()].some((key) => key.startsWith(`${a.id}::`))).toBe(false)
  store.setState({ openFiles: [] })
  await Promise.resolve()
  expect(scrollTopCache.size).toBe(0)
})

it('spares a check ID reopened before the pending flush', async () => {
  const { store, attach } = createModelLifetimeFixture(false)
  const file = modelLifetimeFile('reopened', 'check-details')
  store.setState({ openFiles: [file] })
  attach()
  seed(file.id)
  store.setState({ openFiles: [] })
  store.setState({ openFiles: [file] })
  await Promise.resolve()
  expect(scrollTopCache.size).toBe(5)
})
