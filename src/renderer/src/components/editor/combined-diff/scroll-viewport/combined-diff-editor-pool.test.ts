// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { combinedDiffEditorPool } from './combined-diff-editor-pool'
import type { CombinedDiffViewportOwner, DiffViewportItem } from './combined-diff-viewport-owner'

const native = vi.hoisted(() => ({
  editors: 0,
  models: 0,
  diffs: 0,
  createdEditors: 0,
  createdDiffs: 0
}))
vi.mock('@/lib/editor/monaco/monaco-setup', () => ({
  monaco: {
    Uri: { parse: (value: string) => value },
    editor: {
      createModel: () => {
        native.models++
        return { dispose: () => native.models-- }
      },
      createDiffEditor: () => {
        native.editors++
        native.createdEditors++
        return {
          createIndependentViewModel: () => {
            native.diffs++
            native.createdDiffs++
            return { dispose: () => native.diffs-- }
          },
          setModel: () => {},
          dispose: () => native.editors--
        }
      }
    }
  }
}))

describe('combined diff resource lifetime', () => {
  it.each([
    { files: 20, retainedModels: 40, retainedDiffs: 20 },
    { files: 200, retainedModels: 400, retainedDiffs: 200 }
  ])(
    'reuses one visible editor across $files files, preserves revisits and releases the owner',
    ({ files, retainedModels, retainedDiffs }) => {
      native.createdEditors = 0
      native.createdDiffs = 0
      const rawOwner = {
        onDispose: new Set<() => void>(),
        overflow: document.createElement('div')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The pool consumes only onDispose and overflow from its owner in this resource-lifetime test.
      const owner = rawOwner as CombinedDiffViewportOwner
      const items: DiffViewportItem[] = Array.from({ length: files }, (_, index) => ({
        key: `file-${index}`,
        generation: '1',
        owner,
        index,
        height: 1000,
        collapsed: false,
        measured: false,
        retired: false,
        node: null,
        chrome: { header: null, conflict: null, body: null },
        binding: null,
        onRetire: new Set<() => void>()
      }))
      const pool = combinedDiffEditorPool(owner)
      const options: editor.IDiffEditorConstructionOptions = { renderSideBySide: true }
      try {
        for (const item of items) {
          const template = pool.acquire(options)
          pool.item(
            item,
            template,
            { original: 'before', modified: 'after', language: 'text' },
            options,
            800
          )
          pool.release(template)
        }
        expect(native.editors).toBe(1)
        expect(native.createdEditors).toBe(1)
        expect(native.models).toBe(retainedModels)
        expect(native.diffs).toBe(retainedDiffs)
        for (const item of items) {
          const template = pool.acquire(options)
          pool.item(
            item,
            template,
            { original: 'before', modified: 'after', language: 'text' },
            options,
            800
          )
          pool.release(template)
        }
        expect(native.createdEditors).toBe(1)
        expect(native.createdDiffs).toBe(retainedDiffs)
      } finally {
        for (const item of items) {
          for (const retire of item.onRetire) {
            retire()
          }
        }
        for (const dispose of owner.onDispose) {
          dispose()
        }
      }
      expect(native.editors).toBe(0)
      expect(native.models).toBe(0)
      expect(native.diffs).toBe(0)
    }
  )
})
