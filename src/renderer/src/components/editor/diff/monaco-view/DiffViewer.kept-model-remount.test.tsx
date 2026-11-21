// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DiffViewer from './DiffViewer'

const HEAD = 'export const hello = 1\n'

beforeEach(() => {
  // happy-dom has no canvas or module workers; the diff computation never needs to finish here.
  const members = new Map<PropertyKey, unknown>([
    ['webkitBackingStorePixelRatio', 1],
    ['measureText', (value: string) => ({ width: value.length * 8 })]
  ])
  const context = new Proxy(
    {},
    { get: (_target, key) => (members.has(key) ? members.get(key) : () => {}) }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Monaco only measures text and paints rulers here; painting is a no-op.
    context as unknown as CanvasRenderingContext2D
  )
  vi.stubGlobal(
    'Worker',
    class {
      postMessage(): void {}
      terminate(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

async function mountChanges(
  modifiedContent: string,
  onContentChange: (content: string) => void
): Promise<{ unmount: () => void; model: monaco.editor.ITextModel }> {
  const view = render(
    <DiffViewer
      modelKey="tab-1"
      modelOwnerKey="tab-1"
      originalModelKey="tab-1:original:head"
      originalContent={HEAD}
      modifiedContent={modifiedContent}
      language="plaintext"
      filePath="/repo/src/index.ts"
      relativePath="src/index.ts"
      sideBySide
      editable
      onContentChange={onContentChange}
    />
  )
  // An editable DiffViewer focuses its modified pane last in onMount, after the kept-model sync.
  const modifiedEditor = await vi.waitFor(() => {
    const mounted = monaco.editor.getDiffEditors()[0]?.getModifiedEditor()
    expect(mounted?.hasTextFocus()).toBe(true)
    return mounted!
  })
  return { unmount: view.unmount, model: modifiedEditor.getModel()! }
}

it('shows text changed elsewhere while unmounted, and Undo cannot bring the old text back', async () => {
  const onContentChange = vi.fn()
  const first = await mountChanges(HEAD, onContentChange)
  first.model.pushEditOperations(
    [],
    [{ range: first.model.getFullModelRange(), text: `${HEAD}// typed in Changes\n` }],
    () => null
  )
  first.unmount()
  onContentChange.mockClear()

  const fromEdit = `${HEAD}// typed in Changes\nexport const fromEdit = 1\n`
  const { model } = await mountChanges(fromEdit, onContentChange)

  expect(model.getValue()).toBe(fromEdit)
  expect(onContentChange).not.toHaveBeenCalled()
  await model.undo()
  expect(model.getValue()).toBe(fromEdit)
})

it('keeps undo history across a remount whose text did not change', async () => {
  const onContentChange = vi.fn()
  const first = await mountChanges(HEAD, onContentChange)
  first.model.pushEditOperations(
    [],
    [{ range: first.model.getFullModelRange(), text: `${HEAD}// typed\n` }],
    () => null
  )
  first.unmount()

  const { model } = await mountChanges(`${HEAD}// typed\n`, onContentChange)
  await model.undo()

  expect(model.getValue()).toBe(HEAD)
})

it('keeps undo history across a remount of a file that starts with a BOM', async () => {
  const onContentChange = vi.fn()
  const bomHead = `\uFEFF${HEAD}`
  const first = await mountChanges(bomHead, onContentChange)
  first.model.pushEditOperations(
    [],
    [{ range: first.model.getFullModelRange(), text: `${HEAD}// typed\n` }],
    () => null
  )
  first.unmount()

  const { model } = await mountChanges(`\uFEFF${HEAD}// typed\n`, onContentChange)
  await model.undo()

  expect(model.getValue()).toBe(HEAD)
})

it('keeps Changes typing that never became a draft when the text did not change elsewhere', async () => {
  // Read-only and CSV-preview tabs refuse drafts, so the props stay at the disk text while the model has the typing.
  const first = await mountChanges(HEAD, vi.fn())
  first.model.pushEditOperations(
    [],
    [{ range: first.model.getFullModelRange(), text: `${HEAD}// typed\n` }],
    () => null
  )
  first.unmount()

  const { model } = await mountChanges(HEAD, vi.fn())

  expect(model.getValue()).toBe(`${HEAD}// typed\n`)
  await model.undo()
  expect(model.getValue()).toBe(HEAD)
})
