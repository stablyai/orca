import { readNativeChatDraftDocument } from '../../drafts/native-chat-draft-views'
// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { updateNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'

afterEach(cleanup)

function setup(value = '') {
  const inputRef = createRef<NativeChatComposerInput>()
  const onChange = vi.fn()
  const view = render(
    <NativeChatPromptEditor
      inputRef={inputRef}
      initialValue={value}
      disabled={false}
      placeholder="Message"
      onChange={onChange}
      onSelect={vi.fn()}
    />
  )
  return {
    ...view,
    input: inputRef.current!,
    editor: promptEditor(within(view.container).getByRole('textbox')),
    onChange
  }
}

describe('native chat skill editor', () => {
  it('continues replacing the selected text after a composer handoff', () => {
    const inputRef = createRef<NativeChatComposerInput>()
    const text = 'Hello\nworld'
    updateNativeChatComposerDraft('handoff-selection', { text }, 'immediate', undefined, {
      at: 'selection',
      from: 6,
      to: 11,
      target: 'chat-tab',
      pending: true
    })
    render(
      <NativeChatPromptEditor
        scopeKey="handoff-selection"
        positionTarget="chat-tab"
        inputRef={inputRef}
        initialValue={text}
        disabled={false}
        placeholder="Message"
        onChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    expect(inputRef.current?.selectionStart).toBe(6)
    expect(inputRef.current?.selectionEnd).toBe(11)
    act(() => inputRef.current?.insertText?.('there'))
    expect(inputRef.current?.value).toBe('Hello\nthere')
  })

  it('shows attached files as filename pills that serialize to the reference the agent reads', async () => {
    const { input, container, onChange } = setup('See  please')
    act(() => input.setSelectionRange(4, 4))
    await act(async () =>
      input.insertFileReferences!(['/Users/abc/Downloads/test (1).csv', 'C:\\docs\\letter.pdf'])
    )
    const pills = [...container.querySelectorAll('[data-native-chat-file-reference]')]
    expect(pills.map((pill) => pill.textContent)).toEqual(['test (1).csv', 'letter.pdf'])
    expect(pills[0].getAttribute('title')).toBe('/Users/abc/Downloads/test (1).csv')
    const references = '@"/Users/abc/Downloads/test (1).csv" @C:\\docs\\letter.pdf '
    expect(input.value).toBe(`See ${references} please`)
    expect(input.selectionStart).toBe(4 + references.length)
    expect(onChange).toHaveBeenCalled()
    const edited = input.value.replace('letter.pdf', 'letter.pd')
    act(() => {
      input.value = edited
    })
    expect(container.querySelectorAll('[data-native-chat-file-reference]')).toHaveLength(1)
    expect(input.value).toBe(edited)
  })

  it('deletes a skill atomically and restores it with undo', async () => {
    const { input, editor, container } = setup('$rev')
    act(() => input.insertSkill!(0, 4, '$review'))
    act(() => {
      input.setSelectionRange(0, 7)
      editor.commands.deleteSelection()
    })
    expect(input.value).toBe(' ')
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
    await act(async () => {
      editor.commands.undo()
    })
    expect(input.value).toBe('$review ')
    expect(container.querySelector('[data-native-chat-skill]')).not.toBeNull()
  })

  it('reads the current text and caret after edits and undo, separately per editor', async () => {
    const first = setup('one')
    const second = setup('second')
    act(() => first.input.setSelectionRange(3, 3))
    act(() => first.input.insertText!('!'))
    expect(first.input.value).toBe('one!')
    expect(first.input.selectionStart).toBe(4)
    expect(second.input.value).toBe('second')
    await act(async () => {
      first.editor.commands.undo()
    })
    expect(first.input.value).toBe('one')
    expect(first.input.selectionStart).toBe(3)
    expect(second.input.value).toBe('second')
  })

  it('restores selected nodes only in their owning pane draft', async () => {
    const inputRef = createRef<NativeChatComposerInput>()
    const props = {
      inputRef,
      scopeKey: 'pill-pane',
      initialValue: '$rev',
      disabled: false,
      placeholder: 'Message',
      onChange: vi.fn(),
      onSelect: vi.fn()
    }
    const first = render(<NativeChatPromptEditor {...props} />)
    act(() => inputRef.current!.insertSkill!(0, 4, '$review'))
    expect(
      readNativeChatDraftDocument('pill-pane', '$review ')?.content?.[0]?.content?.[0]?.type
    ).toBe('nativeChatSkill')
    first.unmount()
    const second = render(<NativeChatPromptEditor {...props} initialValue="$review " />)
    await waitFor(() =>
      expect(second.container.querySelector('[data-native-chat-skill]')).not.toBeNull()
    )
    second.unmount()
    const other = render(
      <NativeChatPromptEditor {...props} scopeKey="other-pane" initialValue="$review " />
    )
    expect(other.container.querySelector('[data-native-chat-skill]')).toBeNull()
  })

  it.each(['$revision ', '$preview '])(
    'replaces partial skill text with %s without a stale pill',
    (replacement) => {
      const { input, container } = setup('$rev')
      act(() => input.insertSkill!(0, 4, '$review'))
      act(() => {
        input.value = replacement
      })
      expect(input.value).toBe(replacement)
      expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
    }
  )

  it('pastes rich clipboard content as literal text without manufacturing pills', () => {
    const { input, container } = setup()
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: {
        getData: (format: string) =>
          format === 'text/plain'
            ? '$review\nhello'
            : '<span data-native-chat-skill="$review">review</span>'
      }
    })
    expect(input.value).toBe('$review\nhello')
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
  })
})

it('replaces the selection with literal pasted text as one undoable edit', async () => {
  const { input, editor } = setup('hello world')
  act(() => input.setSelectionRange(6, 11))
  await act(async () => input.insertText?.('안녕\n$literal'))
  expect(input.value).toBe('hello 안녕\n$literal')
  await act(async () => {
    editor.commands.undo()
  })
  expect(input.value).toBe('hello world')
})
