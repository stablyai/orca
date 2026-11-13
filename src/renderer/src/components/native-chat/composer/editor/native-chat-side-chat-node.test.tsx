// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, render, waitFor, within } from '@testing-library/react'
import { Editor, type JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { appendNativeChatDraftCache } from '../../drafts/native-chat-draft-views'

afterEach(cleanup)

function setup({
  sideChat = true,
  scopeKey,
  initialValue = ''
}: { sideChat?: boolean; scopeKey?: string; initialValue?: string } = {}) {
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
  const view = render(<NativeChatPromptEditor {...props} sideChat={sideChat} />)
  const editor = promptEditor(within(view.container).getByRole('textbox'))
  return {
    ...view,
    input: inputRef.current!,
    editor,
    rerenderWith: (next: boolean) =>
      view.rerender(<NativeChatPromptEditor {...props} sideChat={next} />)
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

// Through the key handlers, as a key press is: keyboardShortcut() keeps steps and drops selections.
function backspace(editor: Editor): void {
  act(() => {
    const event = new KeyboardEvent('keydown', { key: 'Backspace' })
    editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, event))
  })
}

const pill = (container: HTMLElement) => container.querySelector('[data-native-chat-side-chat]')
// React node views mount after the transaction that inserts them.
const pillShown = (container: HTMLElement) => waitFor(() => expect(pill(container)).not.toBeNull())

describe('side chat pill', () => {
  it('turns a typed /btw into the pill while the draft text stays the command', async () => {
    const { input, editor, container } = setup()
    type(editor, '/btw ')
    await pillShown(container)
    expect(pill(container)?.textContent).toBe('Side chat')
    expect(input.value).toBe('/btw ')
    expect(container.textContent).toContain('Ask a side question')
    type(editor, 'why?')
    expect(input.value).toBe('/btw why?')
    expect(container.textContent).not.toContain('Ask a side question')
  })

  it('keeps /btw plain text where side chat is unavailable, it is not leading, or no ASCII space follows', () => {
    const unavailable = setup({ sideChat: false })
    type(unavailable.editor, '/btw why?')
    expect(pill(unavailable.container)).toBeNull()
    expect(unavailable.input.value).toBe('/btw why?')

    const midDraft = setup()
    type(midDraft.editor, 'hi /side ')
    expect(pill(midDraft.container)).toBeNull()
    expect(midDraft.input.value).toBe('hi /side ')

    const nbsp = setup()
    type(nbsp.editor, '/btw\u00a0why?')
    expect(pill(nbsp.container)).toBeNull()
    expect(nbsp.input.value).toBe('/btw\u00a0why?')
  })

  it('backspaces the pill back into the typed command, caret after it', async () => {
    const empty = setup()
    type(empty.editor, '/BTW ')
    await pillShown(empty.container)
    backspace(empty.editor)
    expect(pill(empty.container)).toBeNull()
    expect(empty.input.value).toBe('/BTW')
    expect(empty.input.selectionStart).toBe(4)

    const asked = setup()
    type(asked.editor, '/side q')
    await pillShown(asked.container)
    act(() => asked.input.setSelectionRange(6, 6))
    backspace(asked.editor)
    expect(pill(asked.container)).toBeNull()
    expect(asked.input.value).toBe('/side q')
    expect(asked.input.selectionStart).toBe(5)
  })

  it('pills a picked command and returns it to text once side chat is unavailable', async () => {
    const view = setup()
    act(() => {
      view.input.value = '/btw '
      view.input.pillSideChatCommand!()
    })
    expect(view.input.value).toBe('/btw ')
    await pillShown(view.container)
    view.rerenderWith(false)
    expect(pill(view.container)).toBeNull()
    expect(view.input.value).toBe('/btw ')
    expect(view.container.textContent).not.toContain('Ask a side question')
  })

  it('saves the pill as text, so an editor without the node keeps and edits the draft', async () => {
    const scopeKey = 'side-chat-old-schema'
    const { editor } = setup({ scopeKey })
    type(editor, '/btw why?')
    await pillShown(document.body)
    const saved = readNativeChatComposerDraft(scopeKey)
    expect(saved.text).toBe('/btw why?')
    expect(JSON.stringify(saved.document)).not.toContain('nativeChatSideChat')

    const older = new Editor({ extensions: [StarterKit], content: saved.document as JSONContent })
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
    expect(setup({ scopeKey, initialValue: text }).input.value).toBe(text)
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

  it('returns the pill to text once anything is typed before it', async () => {
    const { input, editor, container } = setup()
    type(editor, '/btw q')
    await pillShown(container)
    act(() => input.setSelectionRange(0, 0))
    type(editor, 'x')
    expect(pill(container)).toBeNull()
    expect(input.value).toBe('x/btw q')
  })
})
