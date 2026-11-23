// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, render, waitFor, within } from '@testing-library/react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { closeHistory } from '@tiptap/pm/history'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { SIDE_CHAT_NODE } from './native-chat-side-chat-node'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { appendNativeChatDraftCache } from '../../drafts/native-chat-draft-views'

afterEach(cleanup)

function setup({ scopeKey, initialValue = '' }: { scopeKey?: string; initialValue?: string } = {}) {
  const inputRef = createRef<NativeChatComposerInput>()
  const props = {
    inputRef,
    scopeKey,
    initialValue,
    disabled: false,
    placeholder: 'Message',
    onChange: vi.fn(),
    onSelect: vi.fn()
  }
  const view = render(<NativeChatPromptEditor {...props} sideChat />)
  const textbox = within(view.container).getByRole('textbox')
  // Tiptap exposes its editor on the ProseMirror root element.
  if (!('editor' in textbox) || !(textbox.editor instanceof Editor)) {
    throw new Error('prompt editor not mounted')
  }
  const editor = textbox.editor
  return {
    ...view,
    input: inputRef.current!,
    editor,
    disableSideChat: () => view.rerender(<NativeChatPromptEditor {...props} sideChat={false} />)
  }
}

// Keyboard text input, which input rules see; programmatic writes never reach them.
function type(editor: Editor, text: string): void {
  act(() => {
    for (const character of text) {
      const { view } = editor
      const { from, to } = view.state.selection
      const insert = () => view.state.tr.insertText(character, from, to)
      if (!view.someProp('handleTextInput', (f) => f(view, from, to, character, insert))) {
        view.dispatch(insert())
      }
    }
  })
}

const pill = (container: HTMLElement) => container.querySelector('[data-native-chat-side-chat]')
// React node views mount after the transaction that inserts them.
const pillShown = (container: HTMLElement) => waitFor(() => expect(pill(container)).not.toBeNull())
// Read from the document: a removed or never-mounted node view looks the same in the DOM.
const pillCount = (editor: Editor) =>
  JSON.stringify(editor.getJSON()).split('"nativeChatSideChat"').length - 1

// Once Send would no longer open a side chat, no history step may bring the pill back.
describe('side chat pill availability', () => {
  it('leaves no pill after undo and redo once side chat is unavailable', () => {
    const { input, editor, disableSideChat } = setup()
    act(() => {
      editor.commands.insertContent([
        { type: SIDE_CHAT_NODE, attrs: { token: '/btw ' } },
        { type: 'text', text: 'why?' }
      ])
    })
    expect(input.value).toBe('/btw why?')
    expect(pillCount(editor)).toBe(1)
    act(() => {
      editor.view.dispatch(closeHistory(editor.state.tr))
      editor.commands.selectAll()
      editor.commands.deleteSelection()
    })
    expect(input.value).toBe('')
    expect(pillCount(editor)).toBe(0)
    disableSideChat()
    act(() => {
      editor.commands.undo()
    })
    expect(input.value).toBe('/btw why?')
    expect(pillCount(editor)).toBe(0)
    act(() => {
      editor.commands.undo()
    })
    expect(input.value).toBe('')
    expect(pillCount(editor)).toBe(0)
    act(() => {
      editor.commands.redo()
    })
    expect(input.value).toBe('/btw why?')
    expect(pillCount(editor)).toBe(0)
  })
})

// The pill is display only: a saved draft must stay the typed text, so older builds and
// editors without the node never lose or rewrite it.
describe('side chat pill drafts', () => {
  it('saves the pill as text, so an editor without the node keeps and edits the draft', async () => {
    const scopeKey = 'side-chat-old-schema'
    const { editor } = setup({ scopeKey })
    type(editor, '/btw why?')
    await pillShown(document.body)
    const saved = readNativeChatComposerDraft(scopeKey)
    expect(saved.text).toBe('/btw why?')
    expect(JSON.stringify(saved.document)).not.toContain('nativeChatSideChat')

    const older = new Editor({
      extensions: [StarterKit],
      content: saved.document ?? null
    })
    older.commands.insertContentAt(older.state.doc.content.size - 1, ' now')
    expect(older.getText()).toBe('/btw why? now')
    older.destroy()
  })

  it('keeps a pill-only draft and appended text equal to the saved text', async () => {
    const scopeKey = 'side-chat-pill-only'
    const first = setup({ scopeKey })
    type(first.editor, '/btw ')
    await pillShown(first.container)
    first.unmount()
    act(() => {
      appendNativeChatDraftCache(scopeKey, 'question')
    })
    const { text } = readNativeChatComposerDraft(scopeKey)
    // Appending trims the draft's trailing whitespace before the blank line, as for any draft.
    expect(text).toBe('/btw\n\nquestion')
    expect(setup({ scopeKey, initialValue: text }).input.value).toBe('/btw\n\nquestion')
  })

  it('shows a saved draft as the pill again, its text unchanged after text is appended', async () => {
    const scopeKey = 'side-chat-remount'
    const first = setup({ scopeKey })
    type(first.editor, '/btw why?')
    await pillShown(first.container)
    first.unmount()
    act(() => {
      appendNativeChatDraftCache(scopeKey, 'more')
    })
    const { text } = readNativeChatComposerDraft(scopeKey)
    expect(text).toBe('/btw why?\n\nmore')
    const second = setup({ scopeKey, initialValue: text })
    await pillShown(second.container)
    expect(second.input.value).toBe(text)
  })
})
