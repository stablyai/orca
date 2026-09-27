import { describe, expect, it } from 'vitest'
import { parseMouseShortcutInput } from './mouse-shortcut-input'

describe('native mouse shortcut input', () => {
  const input = { key: 'MouseBack', altKey: false, ctrlKey: true, metaKey: false, shiftKey: false }
  it('accepts only canonical side buttons with explicit boolean modifiers', () => {
    expect(parseMouseShortcutInput(input)).toEqual(input)
    expect(parseMouseShortcutInput({ ...input, key: 'MouseForward' })?.key).toBe('MouseForward')
    for (const invalid of [
      null,
      'MouseBack',
      {},
      { ...input, key: 'R' },
      { ...input, ctrlKey: 'true' }
    ]) {
      expect(parseMouseShortcutInput(invalid)).toBeNull()
    }
  })
  it('strips fields that could change shortcut resolution', () => {
    expect(
      parseMouseShortcutInput({ ...input, control: false, doubleTapModifier: 'Ctrl' })
    ).toEqual(input)
  })
})
