// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'

afterEach(cleanup)

function setup(value: string) {
  const inputRef = createRef<NativeChatComposerInput>()
  const rendered = render(
    <NativeChatPromptEditor
      inputRef={inputRef}
      initialValue={value}
      disabled={false}
      placeholder="Message"
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />
  )
  const element = within(rendered.container).getByRole('textbox')
  const editor = promptEditor(element)
  const input = inputRef.current!
  act(() => input.setSelectionRange(value.length, value.length))
  const tab = (options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
      ...options
    })
    act(() => element.dispatchEvent(event))
    return event
  }
  return { input, editor, element, tab }
}

describe('native chat list indentation', () => {
  it('nests an item, keeps its caret, and supports undo, redo and outdent', () => {
    const { input, editor, tab } = setup('- 요구사항\n- 세부 조건')
    act(() => input.setSelectionRange(10, 10))
    expect(tab().defaultPrevented).toBe(true)
    expect(input.value).toBe('- 요구사항\n    - 세부 조건')
    expect(input.selectionStart).toBe(14)
    act(() => {
      editor.commands.undo()
    })
    expect(input.value).toBe('- 요구사항\n- 세부 조건')
    expect(input.selectionStart).toBe(10)
    act(() => {
      editor.commands.redo()
    })
    expect(input.value).toBe('- 요구사항\n    - 세부 조건')
    expect(input.selectionStart).toBe(14)
    expect(tab({ shiftKey: true }).defaultPrevented).toBe(true)
    expect(input.value).toBe('- 요구사항\n- 세부 조건')
  })

  it('keeps inline file chips when indenting an item', async () => {
    const { input, element, tab } = setup('- parent\n- see ')
    await act(async () => input.insertFileReferences!(['/tmp/spec.md']))
    tab()
    expect(input.value).toBe('- parent\n    - see @/tmp/spec.md ')
    expect(element.querySelector('[data-native-chat-file-reference]')?.textContent).toBe('spec.md')
  })

  it('uses enough indentation for a wide numbered parent and outdents to that parent', () => {
    const { input, tab } = setup('1000. parent\n1001. child')
    tab()
    expect(input.value).toBe('1000. parent\n      1001. child')
    tab({ shiftKey: true })
    expect(input.value).toBe('1000. parent\n1001. child')
  })

  it('finds a sibling before its nested children', () => {
    const { input, tab } = setup('* parent\n    + nested\n* sibling')
    tab()
    expect(input.value).toBe('* parent\n    + nested\n    * sibling')
  })

  it('keeps focus navigation, fenced code, selections, IME and picker input ahead of indentation', () => {
    for (const value of [
      'ordinary prose',
      '- first item',
      '```markdown\n- parent\n- literal',
      '~~~markdown\n- parent\n- literal',
      '```markdown\n- ```\n- parent\n- literal'
    ]) {
      const { input, tab } = setup(value)
      expect(tab().defaultPrevented).toBe(false)
      expect(input.value).toBe(value)
      cleanup()
    }

    const value = '- parent\n- child'
    const { input, element, tab } = setup(value)
    expect(tab({ shiftKey: true }).defaultPrevented).toBe(false)
    act(() => input.setSelectionRange(11, 16))
    expect(tab().defaultPrevented).toBe(false)
    act(() => input.setSelectionRange(16, 16))
    expect(tab({ isComposing: true }).defaultPrevented).toBe(false)
    expect(tab({ keyCode: 229 }).defaultPrevented).toBe(false)
    expect(tab({ ctrlKey: true }).defaultPrevented).toBe(false)
    const consume = (event: KeyboardEvent) => event.preventDefault()
    element.addEventListener('keydown', consume, { capture: true })
    tab()
    expect(input.value).toBe(value)
    element.removeEventListener('keydown', consume, { capture: true })
    tab()
    expect(input.value).toBe('- parent\n    - child')
  })

  it('resumes list editing after a closed code fence', () => {
    const { input, tab } = setup('```\n- literal\n```\n- parent\n- child')
    tab()
    expect(input.value).toBe('```\n- literal\n```\n- parent\n    - child')
  })
})
