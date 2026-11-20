// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { botMentionToken } from '../../../../../../shared/bots/bot-mention-context'
import { nativeChatPromptPillKey } from './native-chat-prompt-pill-keys'

afterEach(cleanup)

const TOKEN = botMentionToken({ id: 'nora', name: 'Eng - Nora' })

// Positions: the paragraph opens at 0, its text starts at 1; a pill is one position wide.
function setup(value: string, caret: number) {
  const inputRef = createRef<NativeChatComposerInput>()
  const view = render(
    <NativeChatPromptEditor
      inputRef={inputRef}
      initialValue={value}
      disabled={false}
      placeholder="Message"
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />
  )
  const editor = promptEditor(within(view.container).getByRole('textbox'))
  act(() => {
    editor.commands.setTextSelection(caret)
  })
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      fireEvent.keyDown(editor.view.dom, { key, ...init })
    })
  const caretAt = () => {
    const { selection } = editor.state
    expect(selection).toBeInstanceOf(TextSelection)
    expect(selection.empty).toBe(true)
    return selection.from
  }
  return { input: inputRef.current!, editor, press, caretAt }
}

it('deletes the whole pill in one Backspace and restores it on undo', () => {
  const { input, editor, press, caretAt } = setup(`ab ${TOKEN} cd`, 5)
  press('Backspace')
  expect(input.value).toBe('ab  cd')
  expect(caretAt()).toBe(4)
  act(() => {
    editor.commands.undo()
  })
  expect(input.value).toBe(`ab ${TOKEN} cd`)
})

it('Delete right before a pill deletes the whole pill in one press', () => {
  const { input, press, caretAt } = setup(`ab ${TOKEN} cd`, 4)
  press('Delete')
  expect(input.value).toBe('ab  cd')
  expect(caretAt()).toBe(4)
})

it('one ArrowLeft or ArrowRight steps over a pill, not onto it', () => {
  const { press, caretAt } = setup(`ab ${TOKEN} cd`, 5)
  press('ArrowLeft')
  expect(caretAt()).toBe(4)
  press('ArrowRight')
  expect(caretAt()).toBe(5)
})

it('handles a pill at the start of the draft', () => {
  const { input, press, caretAt } = setup(`${TOKEN} cd`, 2)
  press('ArrowLeft')
  expect(caretAt()).toBe(1)
  // Nothing before the caret: the pill after it stays.
  press('Backspace')
  expect(input.value).toBe(`${TOKEN} cd`)
  press('Delete')
  expect(input.value).toBe(' cd')
  expect(caretAt()).toBe(1)
})

it('handles a pill at the end of the draft', () => {
  const { input, press, caretAt } = setup(`ab ${TOKEN}`, 4)
  press('ArrowRight')
  expect(caretAt()).toBe(5)
  // Nothing after the caret: the pill before it stays.
  press('Delete')
  expect(input.value).toBe(`ab ${TOKEN}`)
  press('Backspace')
  expect(input.value).toBe('ab ')
  expect(caretAt()).toBe(4)
})

it('takes two adjacent pills one press each', () => {
  const { input, press, caretAt } = setup(`a ${TOKEN}${TOKEN} z`, 5)
  press('Backspace')
  expect(input.value).toBe(`a ${TOKEN} z`)
  expect(caretAt()).toBe(4)
  press('Backspace')
  expect(input.value).toBe('a  z')
})

it('leaves plain text beside the caret to the editor', () => {
  const { editor } = setup(`ab ${TOKEN} cd`, 7)
  expect(nativeChatPromptPillKey(editor.view, 'ArrowLeft')).toBe(false)
  expect(nativeChatPromptPillKey(editor.view, 'Backspace')).toBe(false)
  expect(editor.state.selection.from).toBe(7)
})

it('leaves a selected pill to the editor: Backspace deletes it, Shift+Arrow is not taken', () => {
  const { input, editor, press } = setup(`ab ${TOKEN} cd`, 5)
  const selectPill = () =>
    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 4)))
    })
  selectPill()
  expect(nativeChatPromptPillKey(editor.view, 'ArrowRight')).toBe(false)
  press('ArrowRight', { shiftKey: true })
  expect(input.value).toBe(`ab ${TOKEN} cd`)
  selectPill()
  press('Backspace')
  expect(input.value).toBe('ab  cd')
})

it('leaves keys alone while an IME composition owns the caret', () => {
  const { input, editor, press } = setup(`ab ${TOKEN} cd`, 5)
  Object.defineProperty(editor.view, 'composing', { configurable: true, get: () => true })
  try {
    press('Backspace')
    press('ArrowLeft')
    expect(input.value).toBe(`ab ${TOKEN} cd`)
    expect(editor.state.selection.from).toBe(5)
  } finally {
    Reflect.deleteProperty(editor.view, 'composing')
  }
})

it('leaves arrows in right-to-left text to the editor, which knows left is forward there', () => {
  const { input, editor } = setup(`שלום ${TOKEN} עולם`, 7)
  expect(nativeChatPromptPillKey(editor.view, 'ArrowLeft')).toBe(false)
  expect(nativeChatPromptPillKey(editor.view, 'ArrowRight')).toBe(false)
  // Deleting is direction-free: Backspace still takes the pill before the caret.
  act(() => {
    expect(nativeChatPromptPillKey(editor.view, 'Backspace')).toBe(true)
  })
  expect(input.value).toBe('שלום  עולם')
})
