import { readNativeChatDraftDocument } from './native-chat-draft-cache'
// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'

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
    editor: promptEditor(screen.getByRole('textbox')),
    onChange
  }
}

describe('native chat skill editor', () => {
  it('renders only picker insertions as pills and serializes the exact invocation', () => {
    const { input, container } = setup('Please $rev')
    act(() => input.insertSkill!(7, 11, '$review'))
    expect(container.querySelector('[data-native-chat-skill]')?.textContent).toBe('Review')
    expect(input.value).toBe('Please $review ')
    expect(input.selectionStart).toBe(15)
    act(() => {
      input.value += '$review typed manually'
    })
    expect(container.querySelectorAll('[data-native-chat-skill]')).toHaveLength(1)
    expect(input.value).toBe('Please $review $review typed manually')
  })

  it('keeps typed and restored invocations plain', () => {
    const { container, input } = setup('$review /review')
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
    act(() => {
      input.value = '$review restored'
    })
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
  })

  it('deletes a skill atomically and restores it with undo', () => {
    const { input, editor, container } = setup('$rev')
    act(() => input.insertSkill!(0, 4, '$review'))
    act(() => {
      input.setSelectionRange(0, 7)
      editor.commands.deleteSelection()
    })
    expect(input.value).toBe(' ')
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
    act(() => {
      editor.commands.undo()
    })
    expect(input.value).toBe('$review ')
    expect(container.querySelector('[data-native-chat-skill]')).not.toBeNull()
  })

  it('preserves multiple selected skills through multiline edits and clears them on send', () => {
    const { input, container } = setup('$one')
    act(() => input.insertSkill!(0, 4, '$one'))
    act(() => {
      input.value += '\nthen $two'
    })
    act(() => input.insertSkill!(11, 15, '$two'))
    expect(input.value).toBe('$one \nthen $two ')
    expect(container.querySelectorAll('[data-native-chat-skill]')).toHaveLength(2)
    act(() => {
      input.value = ''
    })
    expect(input.value).toBe('')
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
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
