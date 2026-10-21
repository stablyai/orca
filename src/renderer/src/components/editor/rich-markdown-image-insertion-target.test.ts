// @vitest-environment happy-dom
import { Editor, Extension } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Plugin } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureRichMarkdownImageInsertionTarget } from './rich-markdown-image-insertion-target'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  captureRichMarkdownClipboardInsertionOrder,
  richMarkdownClipboardInsertionOrderKey
} from './rich-markdown-clipboard-insertion-order'

const editors: Editor[] = []

function editorAt(from: number, to = from, extensions: Extension[] = []) {
  const editor = new Editor({
    extensions: [StarterKit, ...extensions],
    content: '<p>hello world</p>'
  })
  document.body.append(editor.view.dom)
  editor.commands.setTextSelection({ from, to })
  editors.push(editor)
  return editor
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('pending rich Markdown image insertion targets', () => {
  it('maps both ends of a reversed selection after earlier text changes', () => {
    const editor = editorAt(12, 7)
    const target = captureRichMarkdownImageInsertionTarget(editor)
    editor.view.dispatch(editor.state.tr.insertText('prefix ', 1))
    expect(target?.getRange()).toMatchObject({ from: 14, to: 19 })
    target?.dispose()
  })

  it('excludes subsequent typing at either selected-range boundary', () => {
    const editor = editorAt(7, 12)
    const target = captureRichMarkdownImageInsertionTarget(editor)
    editor.view.dispatch(editor.state.tr.insertText('start ', 7))
    editor.view.dispatch(editor.state.tr.insertText(' end', 18))
    expect(target?.getRange()).toMatchObject({ from: 13, to: 18 })
    target?.dispose()
  })

  it('keeps a collapsed pending paste before text typed at the same caret', () => {
    const editor = editorAt(7)
    const target = captureRichMarkdownImageInsertionTarget(editor)
    editor.commands.insertContent('typed ')
    expect(target?.getRange()).toMatchObject({ from: 7, to: 7 })
    target?.dispose()
  })

  it.each(['replace', 'delete', 'insert'])(
    'cancels when %s changes selected content',
    (operation) => {
      const editor = editorAt(7, 12)
      const target = captureRichMarkdownImageInsertionTarget(editor)
      const tr = editor.state.tr
      if (operation === 'replace') {
        tr.insertText('changed', 7, 12)
      } else if (operation === 'delete') {
        tr.delete(7, 12)
      } else {
        tr.insertText('new', 9)
      }
      editor.view.dispatch(tr)
      expect(target?.getRange()).toBeNull()
    }
  )

  it('cancels a collapsed anchor deleted by a document replacement', () => {
    const editor = editorAt(7)
    const target = captureRichMarkdownImageInsertionTarget(editor)
    editor.commands.setContent('<p>different document</p>')
    expect(target?.getRange()).toBeNull()
  })

  it('keeps the target through a no-op content replacement', () => {
    const editor = editorAt(7, 12)
    const target = captureRichMarkdownImageInsertionTarget(editor)
    editor.commands.setContent(editor.getJSON())
    expect(target?.getRange()).toMatchObject({ from: 7, to: 12 })
    target?.dispose()
  })

  it('keeps a target when resolver settings retain the same file and owner', () => {
    const editor = editorAt(7, 12)
    const context = { filePath: '/repo/note.md' }
    setRichMarkdownImageResolverContext(editor, context)
    const target = captureRichMarkdownImageInsertionTarget(editor)
    expect(setRichMarkdownImageResolverContext(editor, { ...context })).toBe(false)
    expect(target?.getRange()).toMatchObject({ from: 7, to: 12 })
    target?.dispose()
  })

  it('maps the root and appended transaction exactly once', () => {
    const appendPrefix = Extension.create({
      name: 'appendPrefix',
      addProseMirrorPlugins: () => [
        new Plugin({
          appendTransaction(transactions, _oldState, state) {
            return transactions.some((tr) => tr.getMeta('appendPrefix'))
              ? state.tr.insertText('next ', 1)
              : null
          }
        })
      ]
    })
    const editor = editorAt(7, 12, [appendPrefix])
    const target = captureRichMarkdownImageInsertionTarget(editor)
    editor.view.dispatch(editor.state.tr.insertText('first ', 1).setMeta('appendPrefix', true))
    expect(editor.getText()).toBe('next first hello world')
    expect(target?.getRange()).toMatchObject({ from: 18, to: 23 })
    target?.dispose()
  })

  it.each(['first', 'second'])('orders two same-caret requests when %s finishes first', (first) => {
    const editor = editorAt(7)
    const earlier = captureRichMarkdownImageInsertionTarget(editor)
    const later = captureRichMarkdownImageInsertionTarget(editor)
    const completing = first === 'first' ? earlier : later
    const pending = first === 'first' ? later : earlier
    const range = completing?.getRange()
    if (!range) {
      throw new Error('Missing image insertion target')
    }
    editor.view.dispatch(
      editor.state.tr
        .insertText('image ', range.from)
        .setMeta(richMarkdownClipboardInsertionOrderKey, range.requestOrder)
    )
    expect(pending?.getRange()).toMatchObject({ from: first === 'first' ? 13 : 7 })
    earlier?.dispose()
    later?.dispose()
  })

  it('detaches transaction and destroy listeners when disposed or destroyed', () => {
    const editor = editorAt(7)
    const off = vi.spyOn(editor, 'off')
    const target = captureRichMarkdownImageInsertionTarget(editor)
    target?.dispose()
    target?.dispose()
    expect(off.mock.calls.map(([event]) => event)).toEqual(['transaction', 'destroy'])
    expect(target?.getRange()).toBeNull()
    const pending = captureRichMarkdownImageInsertionTarget(editor)
    editor.destroy()
    expect(pending?.getRange()).toBeNull()
  })

  it('rejects disconnected and disabled editor targets', () => {
    const editor = editorAt(7)
    const target = captureRichMarkdownImageInsertionTarget(editor)
    editor.view.dom.remove()
    expect(target?.getRange()).toBeNull()
    expect(captureRichMarkdownImageInsertionTarget(editor)).toBeNull()
    document.body.append(editor.view.dom)
    editor.setEditable(false)
    expect(target?.getRange()).toBeNull()
    expect(captureRichMarkdownImageInsertionTarget(editor)).toBeNull()
    target?.dispose()
  })

  it.each(['earlier text paste', 'later text paste', 'ordinary typing'] as const)(
    'orders a pending image against %s while preserving the live caret',
    (counterpart) => {
      const editor = new Editor({
        extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
        content: 'hello world',
        contentType: 'markdown'
      })
      editors.push(editor)
      document.body.append(editor.view.dom)
      editor.commands.setTextSelection(7)
      const earlierOrder =
        counterpart === 'earlier text paste'
          ? captureRichMarkdownClipboardInsertionOrder(editor)
          : null
      const target = captureRichMarkdownImageInsertionTarget(editor)
      const tr = editor.state.tr.insertText('text', 7)
      if (counterpart !== 'ordinary typing') {
        tr.setMeta(
          richMarkdownClipboardInsertionOrderKey,
          earlierOrder ?? captureRichMarkdownClipboardInsertionOrder(editor)
        )
      }
      editor.view.dispatch(tr)
      const range = target?.getRange()
      if (!range) {
        throw new Error('Missing image insertion target')
      }
      expect(range.from).toBe(counterpart === 'earlier text paste' ? 11 : 7)
      editor
        .chain()
        .insertContentAt(
          range.from,
          { type: 'image', attrs: { src: 'image.png' } },
          {
            updateSelection: false
          }
        )
        .setMeta(richMarkdownClipboardInsertionOrderKey, range.requestOrder)
        .run()
      expect(editor.getMarkdown()).toBe(
        counterpart === 'earlier text paste'
          ? 'hello text![](image.png)world'
          : 'hello ![](image.png)textworld'
      )
      expect(editor.state.selection.from).toBe(12)
      editor.state.doc.check()
      target?.dispose()
    }
  )
})
