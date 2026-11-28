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

  it('indents to the parent item content column', () => {
    const tab = (text: string, at: number): string =>
      applyNativeChatTextEdits(text, shiftListIndent(text, at, at, false)!.edits)
    expect(tab('1. a\n- b', 5)).toBe('1. a\n   - b')
    expect(tab('10. a\n- b', 7)).toBe('10. a\n    - b')
    expect(tab('- a\n1. b', 5)).toBe('- a\n  1. b')
  })

  it('renumbers the groups an indent change leaves and joins', () => {
    const run = (text: string, at: number, outdent: boolean): string =>
      applyNativeChatTextEdits(text, shiftListIndent(text, at, at, outdent)!.edits)
    expect(run('1. a\n2. b\n3. c', 5, false)).toBe('1. a\n   1. b\n2. c')
    expect(run('1. x\n   1. a\n   2. b', 17, true)).toBe('1. x\n   1. a\n2. b')
  })

  it('maps each selection end through the indent edits', () => {
    expect(shiftListIndent('   1. a\n   2. b', 7, 9, true)!.selection).toEqual({ from: 4, to: 5 })
  })

  it('removes italic from bold-and-italic text without touching bold', () => {
    const wrap = (text: string, from: number, to: number): string =>
      applyNativeChatTextEdits(text, toggleInlineMark(text, from, to, '*').edits)
    expect(wrap('***bc***', 3, 5)).toBe('**bc**')
    expect(wrap('***bc***', 0, 8)).toBe('**bc**')
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
