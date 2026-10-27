import { describe, expect, it } from 'vitest'
import { fenceEditedCodeBlock } from './native-chat-code-block-edit'

describe('fenceEditedCodeBlock', () => {
  it('fences the edited text with its language', () => {
    expect(fenceEditedCodeBlock('a = 1', 'latex')).toBe('```latex\na = 1\n```')
  })

  it('keeps one trailing newline and allows no language', () => {
    expect(fenceEditedCodeBlock('x\n', undefined)).toBe('```\nx\n```')
  })

  it('outgrows a fence inside the text', () => {
    expect(fenceEditedCodeBlock('```js\nx\n```', 'md')).toBe('````md\n```js\nx\n```\n````')
  })

  it('drops a language label that holds a backtick', () => {
    expect(fenceEditedCodeBlock('x', 'js`x')).toBe('```\nx\n```')
  })
})
