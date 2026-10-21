// @vitest-environment happy-dom
import { createRef } from 'react'
import { NodeSelection } from '@tiptap/pm/state'
import { act, cleanup, fireEvent, render, renderHook, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each([
  ['abc\ndef', 'abc\nX'],
  ['\ndef', '\nX'],
  ['a😀\ndef', 'a😀\nX']
])(
  'keeps the preceding newline when routed typing replaces a modifier-selected paragraph in %j',
  async (draft, expected) => {
    const inputRef = createRef<NativeChatComposerInput>()
    const view = render(
      <NativeChatPromptEditor
        inputRef={inputRef}
        initialValue={draft}
        disabled={false}
        placeholder="Message"
        onChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    const textbox = within(view.container).getByRole('textbox')
    const editor = promptEditor(textbox)
    const input = inputRef.current!
    const blockStart = editor.state.doc.firstChild!.nodeSize
    // happy-dom has no layout; the actual mouse handler still creates the selection.
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({
      pos: blockStart + 2,
      inside: blockStart
    })
    const paragraph = textbox.querySelectorAll('p')[1]
    const isMac = navigator.userAgent.includes('Mac')
    const click = { button: 0, clientX: 1, clientY: 1, metaKey: isMac, ctrlKey: !isMac }
    act(() => {
      fireEvent.mouseDown(paragraph, click)
      fireEvent.mouseUp(paragraph, click)
    })
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(editor.state.selection.from).toBe(blockStart)
    const selection = [input.selectionStart, input.selectionEnd]
    const { result } = renderHook(() =>
      useNativeChatTypedInsertion({
        textareaRef: inputRef,
        caret: draft.length,
        draft: input.value,
        setDraft: (value) => {
          input.value = value
        },
        setCaret: vi.fn(),
        setActiveSuggestion: vi.fn()
      })
    )
    await act(async () => {
      expect(result.current.insertTypedText('X')).toBe(true)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect({ selection, value: input.value }).toEqual({
      selection: [draft.indexOf('\n') + 1, draft.length],
      value: expected
    })
  }
)
