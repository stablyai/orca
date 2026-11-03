// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor, promptValue } from './native-chat-prompt-editor.test-support'

afterEach(cleanup)

function shiftEnterAtEnd(value: string): { text: string; element: HTMLElement } {
  const view = render(
    <NativeChatPromptEditor
      inputRef={createRef<NativeChatComposerInput>()}
      initialValue={value}
      disabled={false}
      placeholder="Message"
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />
  )
  const element = within(view.container).getByRole('textbox')
  const editor = promptEditor(element)
  act(() => {
    editor.commands.focus('end')
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })
    )
  })
  return { text: promptValue(element), element }
}

describe('native chat prompt list continuation', () => {
  it.each([
    ['- first', '- first\n- '],
    ['  - nested', '  - nested\n  - '],
    ['1. first', '1. first\n2. '],
    ['notes\n9. ninth', 'notes\n9. ninth\n10. '],
    ['- done\n- ', '- done\n'],
    ['1. done\n2. ', '1. done\n'],
    ['- done\n-   ', '- done\n'],
    ['1. done\n2.  ', '1. done\n'],
    ['plain', 'plain\n'],
    ['-not a bullet', '-not a bullet\n']
  ])('Shift+Enter after %j gives %j', (value, expected) => {
    expect(shiftEnterAtEnd(value).text).toBe(expected)
  })

  it('shows a line-start dash as a bullet without changing the text', () => {
    const { element } = shiftEnterAtEnd('- one')
    expect(element.querySelectorAll('[class*="content-"]')).toHaveLength(2)
    expect(promptValue(element)).toBe('- one\n- ')
  })
})
