import { describe, expect, it } from 'vitest'
import { countWords, createEditorWordCounter } from './editor-word-count'

describe('editor word count', () => {
  it.each([
    ['', 0],
    [' \t\r\n 　', 0],
    [' hello\tworld\r\n안녕 세상 ', 4],
    ['你好世界', 2],
    ["don't stop", 2],
    ['# Title\n\n- **item**', 2]
  ])('counts words in %j', (text, expected) => {
    expect(countWords(text)).toBe(expected)
  })

  it('follows selection, clearing, edits during selection, and document replacement', () => {
    let document = { text: 'one two three' }
    let selected: string[] = []
    const read = createEditorWordCounter({
      getDocumentVersion: () => document,
      getDocumentLength: () => document.text.length,
      getDocumentText: () => document.text,
      getSelectedText: () => selected
    })
    expect(read()).toEqual({ count: 3, selected: false })
    selected = ['one', 'three']
    expect(read()).toEqual({ count: 2, selected: true })
    selected = ['  \n']
    expect(read()).toEqual({ count: 0, selected: true })
    document = { text: 'four five' }
    selected = ['five']
    expect(read()).toEqual({ count: 1, selected: true })
    selected = []
    expect(read()).toEqual({ count: 2, selected: false })
    document = { text: '' }
    expect(read()).toEqual({ count: 0, selected: false })
  })
})
