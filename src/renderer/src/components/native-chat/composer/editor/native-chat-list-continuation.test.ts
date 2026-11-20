// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, expect, it } from 'vitest'
import { NativeChatListContinuation } from './native-chat-list-continuation'
import { promptText, promptTextPosition } from './native-chat-prompt-document'
import { promptTextContent } from './native-chat-prompt-document-text'

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function shiftEnterAt(text: string, caret = text.length): string {
  editor?.destroy()
  editor = new Editor({
    extensions: [StarterKit, NativeChatListContinuation],
    content: promptTextContent(text)
  })
  editor.commands.setTextSelection(promptTextPosition(editor.state.doc, caret))
  // The view's own key path: Tiptap's keyboardShortcut command drops a multi-step transaction's later steps.
  const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true })
  editor.view.someProp('handleKeyDown', (handle) => handle(editor!.view, event))
  return promptText(editor.state.doc)
}

it('continues bullet and numbered items and ends the list on an empty item', () => {
  expect(shiftEnterAt('- milk')).toBe('- milk\n- ')
  expect(shiftEnterAt('  - nested')).toBe('  - nested\n  - ')
  expect(shiftEnterAt('9. nine')).toBe('9. nine\n10. ')
  expect(shiftEnterAt('- milk\n- ')).toBe('- milk\n')
  expect(shiftEnterAt('1. a\n2. ')).toBe('1. a\n')
  // Mid-item splits it; plain lines and a caret inside the marker keep a plain newline.
  expect(shiftEnterAt('- milkeggs', 6)).toBe('- milk\n- eggs')
  expect(shiftEnterAt('plain')).toBe('plain\n')
  expect(shiftEnterAt('- milk', 1)).toBe('-\n milk')
  expect(shiftEnterAt('-milk')).toBe('-milk\n')
})

it('paints a bullet over the dash of each `- ` line only', () => {
  expect(shiftEnterAt('- a\nb - c\n  - d')).toBe('- a\nb - c\n  - d\n  - ')
  const state = editor!.state
  const dashes = state.plugins
    .flatMap((plugin) => {
      const set = plugin.props.decorations?.call(plugin, state)
      return set instanceof DecorationSet ? set.find() : []
    })
    .map(({ from }) => state.doc.textBetween(from, from + 1))
  expect(dashes).toEqual(['-', '-', '-'])
})
