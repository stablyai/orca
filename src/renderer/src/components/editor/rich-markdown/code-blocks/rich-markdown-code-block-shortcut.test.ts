import { describe, expect, it } from 'vitest'
import { Editor, getExtensionField } from '@tiptap/core'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'

function createMarkdownEditor(markdown: string): Editor {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({
      codec: createRichMarkdownEditorCodec()
    }),
    content: markdown,
    contentType: 'markdown'
  })
}

function codeBlockShortcuts(editor: Editor): Record<string, () => boolean> {
  const extension = editor.extensionManager.extensions.find((item) => item.name === 'codeBlock')
  if (!extension) {
    return {}
  }
  const addKeyboardShortcuts = getExtensionField<
    NonNullable<typeof extension.config.addKeyboardShortcuts>
  >(extension, 'addKeyboardShortcuts', {
    name: extension.name,
    options: extension.options,
    storage: editor.storage,
    editor
  })
  return addKeyboardShortcuts?.() ?? {}
}

describe('rich markdown Mod-Alt-c', () => {
  it('does not turn the current block into a code block', () => {
    const editor = createMarkdownEditor('# Title')
    editor.commands.setTextSelection(2)
    const before = editor.getText()
    const shortcuts = codeBlockShortcuts(editor)
    const toggle = shortcuts['Mod-Alt-c']
    const handled = toggle ? toggle() : false
    expect(handled).toBe(false)
    expect(typeof shortcuts.Backspace).toBe('function')
    expect(editor.isActive('codeBlock')).toBe(false)
    expect(editor.getText()).toBe(before)
    editor.destroy()
  })

  it('still toggles a code block when the command asks for one', () => {
    const editor = createMarkdownEditor('Title')
    editor.commands.setTextSelection(2)
    expect(editor.commands.toggleCodeBlock()).toBe(true)
    expect(editor.isActive('codeBlock')).toBe(true)
    editor.destroy()
  })
})
