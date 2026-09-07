// @vitest-environment happy-dom
import { renderHook, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { captureEditorView, restoreTransferredEditorView } from './editor-view-transfer'
import { useRichMarkdownViewTransfer } from './use-rich-markdown-view-transfer'

afterEach(cleanup)
it('transfers live rich text selection and scroll using independent view identities', () => {
  const source = new Editor({ extensions: [StarterKit], content: '<p>unsaved draft</p>' })
  source.commands.setTextSelection({ from: 2, to: 6 })
  const container = document.createElement('div')
  container.scrollTop = 90
  const original = renderHook(() =>
    useRichMarkdownViewTransfer(
      source,
      'rich-source',
      'scroll-source',
      { current: container },
      () => source.getText()
    )
  )
  const snapshot = captureEditorView('rich-source')!
  expect(snapshot.text).toBe('unsaved draft')
  restoreTransferredEditorView('rich-copy', snapshot)
  const destination = new Editor({ extensions: [StarterKit], content: '<p>unsaved draft</p>' })
  renderHook(() =>
    useRichMarkdownViewTransfer(destination, 'rich-copy', 'scroll-copy', { current: null }, () =>
      destination.getText()
    )
  )
  expect(destination.state.selection.toJSON()).toEqual(source.state.selection.toJSON())
  original.unmount()
  expect(source.isDestroyed).toBe(false)
  source.destroy()
  destination.destroy()
})
