// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, expect, it, vi } from 'vitest'
import {
  attachModelLifetimeView,
  createModelLifetimeFixture,
  modelLifetimeFile,
  modelLifetimeTextModel,
  resetModelLifetimeFixtures
} from './editor-model-lifetime-fixture'
import { getDiffViewerMonacoModelPaths } from './diff-monaco-model-disposal'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
afterEach(resetModelLifetimeFixtures)

function scopedModels(fileId: string, scope: string) {
  const paths = getDiffViewerMonacoModelPaths({
    modelKey: `${fileId}::${scope}`,
    originalModelKey: `${fileId}::${scope}:original:head`,
    generationSuffix: ''
  })
  return [
    modelLifetimeTextModel(paths.originalModelPath),
    modelLifetimeTextModel(paths.modifiedModelPath)
  ]
}

it('releases both Changes panes after switching back to Edit and closing the tab', async () => {
  const { store, bridge, attach } = createModelLifetimeFixture()
  const file = modelLifetimeFile('/repo/a:one.ts')
  const sibling = modelLifetimeFile('/repo/a:one.ts:other')
  const models = [...scopedModels(file.id, 'left'), ...scopedModels(file.id, 'right')]
  const siblingModels = scopedModels(sibling.id, 'left')
  bridge.retainDiffModels(file.id, models)
  bridge.retainDiffModels(sibling.id, siblingModels)
  store.setState({ openFiles: [file, sibling], editorViewMode: { [file.id]: 'edit' } })
  attach()
  const enumeration = vi.spyOn(monaco.editor, 'getModels')
  store.getState().closeFile(file.id)
  await Promise.resolve()
  expect(models.every((model) => model.isDisposed())).toBe(true)
  expect(siblingModels.every((model) => !model.isDisposed())).toBe(true)
  expect(bridge.getRetainedDiffModels(file.id)).toEqual([])
  expect(enumeration).not.toHaveBeenCalled()
})

it('waits for actual detachment and protects a reopened tab from the old close', async () => {
  const { store, bridge, attach } = createModelLifetimeFixture()
  const file = modelLifetimeFile('reopened-changes')
  const models = scopedModels(file.id, 'pane')
  const detach = attachModelLifetimeView(models[0])
  bridge.retainDiffModels(file.id, models)
  store.setState({ openFiles: [file] })
  attach()
  store.getState().closeFile(file.id)
  await Promise.resolve()
  expect(models[0].isDisposed()).toBe(false)
  expect(models[1].isDisposed()).toBe(true)
  store.setState({ openFiles: [file] })
  detach()
  await Promise.resolve()
  expect(models[0].isDisposed()).toBe(false)
  store.getState().closeFile(file.id)
  await Promise.resolve()
  expect(models[0].isDisposed()).toBe(true)
})

it('keeps a successor at the captured URI and a shared file model owner alive', async () => {
  const { store, bridge, attach } = createModelLifetimeFixture()
  const file = modelLifetimeFile('old-changes')
  const sharedFile = { ...file, id: 'same-file-live-tab' }
  const models = scopedModels(file.id, 'pane')
  bridge.retainDiffModels(file.id, models)
  store.setState({ openFiles: [file, sharedFile] })
  attach()
  store.getState().closeFile(file.id)
  const uri = models[0].uri.toString()
  models[0].dispose()
  const successor = modelLifetimeTextModel(uri)
  await Promise.resolve()
  expect(successor.isDisposed()).toBe(false)
  expect(models[1].isDisposed()).toBe(true)
  expect(store.getState().openFiles.map((entry) => entry.id)).toEqual([sharedFile.id])
})

it('releases pane-scoped diff tabs under their exact retained model ownership', async () => {
  const { store, bridge, attach } = createModelLifetimeFixture()
  const file = modelLifetimeFile('scoped-diff', 'diff')
  const models = scopedModels(file.id, 'pane::with:colons')
  bridge.retainDiffModels(file.id, models)
  store.setState({ openFiles: [file] })
  attach()
  const enumeration = vi.spyOn(monaco.editor, 'getModels')
  store.getState().closeFile(file.id)
  await Promise.resolve()
  expect(models.every((model) => model.isDisposed())).toBe(true)
  expect(enumeration).not.toHaveBeenCalled()
})

it('rechecks the tab owner when disposing a previous original reopens its tab', async () => {
  const { store, bridge, attach } = createModelLifetimeFixture()
  const file = modelLifetimeFile('reentrant-changes')
  const models = scopedModels(file.id, 'pane')
  bridge.retainDiffModels(file.id, models)
  store.setState({ openFiles: [file] })
  attach()
  const reopen = models[0].onWillDispose(() => store.setState({ openFiles: [file] }))
  try {
    store.getState().closeFile(file.id)
    await Promise.resolve()
    expect(models[0].isDisposed()).toBe(true)
    expect(models[1].isDisposed()).toBe(false)
  } finally {
    reopen.dispose()
  }
})

it('keeps an unattached retained model while another registered tab owns it', async () => {
  const { store, bridge, attach } = createModelLifetimeFixture()
  const file = modelLifetimeFile('shared-changes')
  const other = modelLifetimeFile('other-changes')
  const models = scopedModels(file.id, 'pane')
  bridge.retainDiffModels(file.id, models)
  bridge.retainDiffModels(other.id, [models[0]])
  store.setState({ openFiles: [file, other] })
  attach()
  store.getState().closeFile(file.id)
  await Promise.resolve()
  expect(models[0].isDisposed()).toBe(false)
  expect(models[1].isDisposed()).toBe(true)
  store.getState().closeFile(other.id)
  await Promise.resolve()
  expect(models[0].isDisposed()).toBe(true)
})
