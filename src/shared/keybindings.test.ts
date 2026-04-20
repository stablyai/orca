import { describe, expect, it } from 'vitest'
import {
  getDefaultKeybindings,
  keyEventToCombo,
  matchesKeyCombo,
  parseKeyCombo
} from './keybindings'

describe('keybindings', () => {
  it('displays zoom-in combos that use the literal plus key', () => {
    expect(parseKeyCombo(getDefaultKeybindings(true).zoomIn, true)).toEqual(['⌘', '+'])
    expect(parseKeyCombo(getDefaultKeybindings(false).zoomIn, false)).toEqual([
      'Ctrl',
      'Shift',
      '+'
    ])
  })

  it('normalizes shifted punctuation keys from event.code', () => {
    const event = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      key: '{',
      code: 'BracketLeft'
    } as KeyboardEvent

    expect(keyEventToCombo(event, true)).toBe('Cmd+Shift+[')
    expect(matchesKeyCombo(event, 'Cmd+Shift+[', true)).toBe(true)
  })

  it('matches legacy plus combos saved with ++ delimiters', () => {
    const event = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      key: '+',
      code: 'Equal'
    } as KeyboardEvent

    expect(keyEventToCombo(event, true)).toBe('Cmd+Plus')
    expect(matchesKeyCombo(event, 'Cmd++', true)).toBe(true)
  })
})
