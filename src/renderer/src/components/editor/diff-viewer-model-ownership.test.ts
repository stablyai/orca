// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import type { editor } from 'monaco-editor'
import { createEditorModelRegistry } from '@/lib/editor-model-registry'
import { modelLifetimeTextModel, resetModelLifetimeFixtures } from './editor-model-lifetime-fixture'
import { retainDiffViewerModelOwner } from './diff-viewer-model-ownership'

afterEach(resetModelLifetimeFixtures)

function modelEditor(initial: editor.ITextModel) {
  let model = initial
  const listeners = new Set<() => void>()
  return {
    getModel: () => model,
    onDidChangeModel(listener: () => void) {
      listeners.add(listener)
      return {
        dispose: () => {
          listeners.delete(listener)
        }
      }
    },
    swap(next: editor.ITextModel): void {
      model = next
      for (const listener of listeners) {
        listener()
      }
    },
    listenerCount: () => listeners.size
  }
}

it('records initial and rotated models and unsubscribes both editor listeners', () => {
  const bridge = createEditorModelRegistry()
  const originalModel = modelLifetimeTextModel('diff:original:owner:first')
  const modifiedModel = modelLifetimeTextModel('diff:modified:owner:first')
  const nextOriginal = modelLifetimeTextModel('diff:original:owner:next')
  const nextModified = modelLifetimeTextModel('diff:modified:owner:next')
  const original = modelEditor(originalModel)
  const modified = modelEditor(modifiedModel)
  const owner = retainDiffViewerModelOwner(
    {
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified
    },
    'tab',
    bridge
  )
  expect(bridge.getRetainedDiffModels('tab')).toEqual([originalModel, modifiedModel])
  original.swap(nextOriginal)
  modified.swap(nextModified)
  expect(bridge.getRetainedDiffModels('tab')).toEqual([
    originalModel,
    modifiedModel,
    nextOriginal,
    nextModified
  ])
  originalModel.dispose()
  modifiedModel.dispose()
  expect(bridge.getRetainedDiffModels('tab')).toEqual([nextOriginal, nextModified])
  owner.dispose()
  expect(original.listenerCount()).toBe(0)
  expect(modified.listenerCount()).toBe(0)
  original.swap(modelLifetimeTextModel('diff:original:later'))
  expect(bridge.getRetainedDiffModels('tab')).toEqual([nextOriginal, nextModified])
})

it('releases shared model records from every owner without borrowing a same-prefix owner', () => {
  const bridge = createEditorModelRegistry()
  const shared = modelLifetimeTextModel('diff:modified:shared')
  const sibling = modelLifetimeTextModel('diff:modified:sibling')
  bridge.retainDiffModels('tab', [shared, shared])
  bridge.retainDiffModels('tab::pane', [shared, sibling])
  expect(bridge.getRetainedDiffModels('tab')).toEqual([shared])
  expect(bridge.getRetainedDiffModelOwners(shared)).toEqual(['tab', 'tab::pane'])
  shared.dispose()
  expect(bridge.getRetainedDiffModels('tab')).toEqual([])
  expect(bridge.getRetainedDiffModels('tab::pane')).toEqual([sibling])
  expect(bridge.getRetainedDiffModelOwners(shared)).toEqual([])
  bridge.retainDiffModels('tab', [shared])
  expect(bridge.getRetainedDiffModels('tab')).toEqual([])
})
