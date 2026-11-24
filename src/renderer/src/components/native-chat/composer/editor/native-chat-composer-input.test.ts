import { describe, expect, it, vi } from 'vitest'
import {
  insertNativeChatPastedText,
  type NativeChatComposerInput
} from './native-chat-composer-input'

describe('insertNativeChatPastedText', () => {
  it('inserts pasted CRLF text as LF lines', () => {
    const insertText = vi.fn()
    const input: NativeChatComposerInput = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      disabled: false,
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
      insertText
    }
    expect(insertNativeChatPastedText(input, 'a\r\nb\r\n')).toBe(true)
    expect(insertText).toHaveBeenCalledWith('a\nb\n')
  })
})
