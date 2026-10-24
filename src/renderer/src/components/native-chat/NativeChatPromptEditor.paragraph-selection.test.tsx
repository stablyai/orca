// @vitest-environment happy-dom
import { createRef } from 'react'
import { NativeChatViewIdentity, retireNativeChatViewState } from './native-chat-view-state-memory'
import { Fragment } from '@tiptap/pm/model'
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
        isComposing: () => false,
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

it('restores the rich editor backward range after keyed park and replaces that range on the next typed action', () => {
  const inputRef = createRef<NativeChatComposerInput>()
  const ui = () => (
    <NativeChatViewIdentity.Provider value="range-return">
      <NativeChatPromptEditor
        inputRef={inputRef}
        initialValue="alpha beta gamma"
        disabled={false}
        placeholder="Message"
        onChange={vi.fn()}
        onSelect={vi.fn()}
      />
    </NativeChatViewIdentity.Provider>
  )
  const before = render(ui())
  act(() =>
    promptEditor(within(before.container).getByRole('textbox')).commands.setTextSelection({
      from: 11,
      to: 7
    })
  )
  before.unmount()
  const returned = render(ui())
  const editor = promptEditor(within(returned.container).getByRole('textbox'))
  expect([editor.state.selection.anchor, editor.state.selection.head]).toEqual([11, 7])
  act(() => editor.commands.insertContent('X'))
  expect(inputRef.current?.value).toBe('alpha X gamma')
  retireNativeChatViewState('range-return')
})

it.each([100, 1000])(
  'bounds retained selection traversal to the rich input at %s paragraphs',
  (paragraphs) => {
    const input = createRef<NativeChatComposerInput>()
    const rendered = render(
      <NativeChatPromptEditor
        inputRef={input}
        initialValue={Array.from({ length: paragraphs }, () => 'line').join('\n')}
        disabled={false}
        placeholder="Message"
        onChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    const editor = promptEditor(within(rendered.container).getByRole('textbox'))
    const walk = Fragment.prototype.nodesBetween
    let visits = 0
    const spy = vi.spyOn(Fragment.prototype, 'nodesBetween').mockImplementation(function (
      this: Fragment,
      from,
      to,
      callback,
      nodeStart,
      parent
    ) {
      walk.call(
        this,
        from,
        to,
        (...args) => {
          visits++
          return callback(...args)
        },
        nodeStart,
        parent
      )
    })
    act(() => editor.commands.setTextSelection({ from: editor.state.doc.content.size - 2, to: 2 }))
    expect(input.current?.selectionStart).toBe(1)
    expect(input.current?.selectionEnd).toBe(paragraphs * 5 - 2)
    expect(visits).toBeGreaterThanOrEqual(paragraphs)
    expect(visits).toBeLessThanOrEqual(20 * paragraphs)
    spy.mockRestore()
  }
)
