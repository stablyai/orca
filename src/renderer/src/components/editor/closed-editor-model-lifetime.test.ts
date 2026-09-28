// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, expect, it, vi } from 'vitest'
import {
  attachModelLifetimeView,
  createModelLifetimeFixture,
  modelLifetimeEditorModel,
  resetModelLifetimeFixtures
} from './editor-model-lifetime-fixture'
import { scrollTopCache } from '@/lib/scroll-cache'

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
  store.setState({ openFiles: [file, { ...file, id: 'shared-b' }] })
  attach()
  store.getState().closeFile(file.id)
  await Promise.resolve()
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
