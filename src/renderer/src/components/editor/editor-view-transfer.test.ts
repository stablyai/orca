import { expect, it } from 'vitest'
import {
  captureEditorView,
  registerEditorView,
  restoreTransferredEditorView
} from './editor-view-transfer'

it('captures current text and version with selection and scroll without disposing the editor', () => {
  let text = 'unsaved'
  let version = 2
  const saved = { cursorState: [], viewState: { scrollTop: 42 } }
  const unregister = registerEditorView('view', () => ({ text, version, state: saved as never }))
  expect(captureEditorView('view')).toEqual({ text: 'unsaved', version: 2, state: saved })
  text = 'late edit'
  version++
  expect(captureEditorView('view')?.version).toBe(3)
  restoreTransferredEditorView('destination', captureEditorView('view')!)
  expect(captureEditorView('destination')?.text).toBe('late edit')
  unregister()
  expect(captureEditorView('view')?.text).toBe('late edit')
})
