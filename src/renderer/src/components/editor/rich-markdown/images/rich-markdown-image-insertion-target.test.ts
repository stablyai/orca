// @vitest-environment happy-dom
import { Editor, Extension } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Plugin } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureRichMarkdownImageInsertionTarget } from './rich-markdown-image-insertion-target'

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
  it('excludes subsequent typing at either selected-range boundary', () => {
    const editor = editorAt(7, 12)
    const target = captureRichMarkdownImageInsertionTarget(editor)
    editor.view.dispatch(editor.state.tr.insertText('start ', 7))
    editor.view.dispatch(editor.state.tr.insertText(' end', 18))
    expect(target?.getRange()).toMatchObject({ from: 13, to: 18 })
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
})
