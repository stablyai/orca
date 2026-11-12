// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { promptEditor } from './native-chat-prompt-editor.test-support'

afterEach(cleanup)

function setup(value: string, scopeKey?: string) {
  const inputRef = createRef<NativeChatComposerInput>()
  const rendered = render(
    <NativeChatPromptEditor
      scopeKey={scopeKey}
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

function typeText(editor: ReturnType<typeof promptEditor>, text: string) {
  act(() => {
    const { from, to } = editor.state.selection
    const insert = () => editor.state.tr.insertText(text, from, to)
    if (
      !editor.view.someProp('handleTextInput', (handle) =>
        handle(editor.view, from, to, text, insert)
      )
    ) {
      editor.view.dispatch(insert())
    }
  })
}

describe('native chat list indentation', () => {
  it('stores a typed bullet as literal text and restores it with indentation and undo', () => {
    const { input, editor, element, tab } = setup('• parent\n-', 'literal-bullet-draft')
    typeText(editor, ' ')
    expect(input.value).toBe('• parent\n• ')
    expect(element.textContent).toBe('• parent• ')
    expect(input.selectionStart).toBe(11)
    act(() => editor.commands.undo())
    expect(input.value).toBe('• parent\n-')
    act(() => editor.commands.redo())
    expect(input.value).toBe('• parent\n• ')
    typeText(editor, 'child')
    tab()
    expect(input.value).toBe('• parent\n    • child')
    expect(readNativeChatComposerDraft('literal-bullet-draft').text).toBe('• parent\n    • child')
    const document = readNativeChatComposerDraft('literal-bullet-draft').document!
    act(() => editor.commands.setContent(document))
    expect(input.value).toBe('• parent\n    • child')
    tab({ shiftKey: true })
    expect(input.value).toBe('• parent\n• child')
    act(() => editor.commands.undo())
    expect(input.value).toBe('• parent\n    • child')
  })

  it('converts a typed marker after a hard break but preserves code and inline punctuation', () => {
    const { input, editor } = setup('• parent')
    act(() => {
      editor.commands.setHardBreak()
      input.insertText!('+')
    })
    typeText(editor, ' ')
    expect(input.value).toBe('• parent\n• ')
    act(() => {
      input.value = '```\n-'
      input.setSelectionRange(5, 5)
    })
    typeText(editor, ' ')
    expect(input.value).toBe('```\n- ')
    act(() => {
      input.value = 'cost *'
      input.setSelectionRange(6, 6)
    })
    typeText(editor, ' ')
    expect(input.value).toBe('cost * ')
  })

  it('nests an item, keeps its caret, and supports undo, redo and outdent', () => {
    const { input, editor, tab } = setup('- 요구사항\n- 세부 조건')
    act(() => input.setSelectionRange(10, 10))
    expect(tab().defaultPrevented).toBe(true)
    expect(input.value).toBe('- 요구사항\n    • 세부 조건')
    expect(input.selectionStart).toBe(14)
    act(() => {
      editor.commands.undo()
    })
    expect(input.value).toBe('- 요구사항\n- 세부 조건')
    expect(input.selectionStart).toBe(10)
    act(() => {
      editor.commands.redo()
    })
    expect(input.value).toBe('- 요구사항\n    • 세부 조건')
    expect(input.selectionStart).toBe(14)
    expect(tab({ shiftKey: true }).defaultPrevented).toBe(true)
    expect(input.value).toBe('- 요구사항\n• 세부 조건')
  })

  it('keeps inline file chips when indenting an item', async () => {
    const { input, element, tab } = setup('- parent\n- see ')
    await act(async () => input.insertFileReferences!(['/tmp/spec.md']))
    tab()
    expect(input.value).toBe('- parent\n    • see @/tmp/spec.md ')
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
    expect(input.value).toBe('* parent\n    + nested\n    • sibling')
  })

  it('nests after a continued item while leaving unrelated prose as a boundary', () => {
    const { input, tab } = setup('- parent\n  continuation\n- child')
    tab()
    expect(input.value).toBe('- parent\n  continuation\n    • child')
    act(() => {
      input.value = '- parent\nunrelated prose\n- child'
      input.setSelectionRange(32, 32)
    })
    expect(tab().defaultPrevented).toBe(false)
    expect(input.value).toBe('- parent\nunrelated prose\n- child')
  })

  it('yields to selection, composition and a consumed Tab before indenting the same item', () => {
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
    expect(input.value).toBe('- parent\n    • child')
  })

  it('does not use an item inside a closed fence as a preceding sibling', () => {
    const { input, tab } = setup('```\n• code\n  ```\n• first')
    expect(tab().defaultPrevented).toBe(false)
    expect(input.value).toBe('```\n• code\n  ```\n• first')
  })

  it('leaves a fenced list literal until the fence closes, then resumes list editing', () => {
    const { input, tab } = setup('-\t```\n    - parent\n    - literal')
    expect(tab().defaultPrevented).toBe(false)
    expect(input.value).toBe('-\t```\n    - parent\n    - literal')
    act(() => input.insertText!('\n    ```\n- parent\n- child'))
    tab()
    expect(input.value).toBe('-\t```\n    - parent\n    - literal\n    ```\n- parent\n    • child')
  })
})
