import { describe, expect, it } from 'vitest'
import {
  applyNativeChatTextEdits,
  continueListAtEnter,
  shiftListIndent,
  toggleInlineMark
} from './native-chat-markdown-list-lines'

function enter(text: string, caret: number): string | null {
  const change = continueListAtEnter(text, caret)
  return change && applyNativeChatTextEdits(text, change.edits)
}

describe('markdown list lines', () => {
  it('continues a numbered item with the next number and renumbers the block below', () => {
    expect(enter('1. a\n2. b', 4)).toBe('1. a\n2. \n3. b')
    expect(enter('  3. x', 7)).toBe('  3. x\n  4. ')
  })

  it('keeps the bullet character and splits text after the caret', () => {
    expect(enter('* one two', 5)).toBe('* one\n*  two')
  })

  it('ends the list on an empty marker and ignores other lines', () => {
    expect(enter('- a\n- ', 6)).toBe('- a\n')
    expect(enter('hello', 5)).toBeNull()
    expect(enter('- a', 1)).toBeNull()
  })

  it('indents and outdents by the marker width', () => {
    const indent = shiftListIndent('- a\n1. b', 0, 0, false)!
    expect(applyNativeChatTextEdits('- a\n1. b', indent.edits)).toBe('  - a\n1. b')
    const numbered = shiftListIndent('1. b', 0, 0, false)!
    expect(applyNativeChatTextEdits('1. b', numbered.edits)).toBe('   1. b')
    const out = shiftListIndent('     - a', 7, 7, true)!
    expect(applyNativeChatTextEdits('     - a', out.edits)).toBe('   - a')
    expect(shiftListIndent('plain', 0, 0, false)).toBeNull()
  })

  it('wraps, unwraps and pairs the selection', () => {
    const wrap = (text: string, from: number, to: number, mark: string): string =>
      applyNativeChatTextEdits(text, toggleInlineMark(text, from, to, mark).edits)
    expect(wrap('a bc d', 2, 4, '**')).toBe('a **bc** d')
    expect(wrap('a **bc** d', 4, 6, '**')).toBe('a bc d')
    expect(wrap('**bc**', 0, 6, '**')).toBe('bc')
    expect(wrap('ab', 1, 1, '*')).toBe('a**b')
    expect(toggleInlineMark('ab', 1, 1, '*').selection).toEqual({ from: 2, to: 2 })
    expect(wrap('**bc**', 2, 4, '*')).toBe('***bc***')
  })
})
