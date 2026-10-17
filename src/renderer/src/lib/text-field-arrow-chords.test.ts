import { describe, expect, it } from 'vitest'
import { isArrowChordUnusedByTextFields } from './text-field-arrow-chords'

describe('isArrowChordUnusedByTextFields', () => {
  it.each([
    [{}],
    [{ shiftKey: true }],
    [{ altKey: true }],
    [{ altKey: true, shiftKey: true }],
    [{ metaKey: true }],
    [{ metaKey: true, shiftKey: true }],
    [{ ctrlKey: true }],
    [{ ctrlKey: true, metaKey: true }],
    [{ altKey: true, ctrlKey: true, metaKey: true }]
  ])('leaves macOS text-field chord %o with the field', (modifiers) => {
    for (const key of ['ArrowUp', 'ArrowDown']) {
      expect(isArrowChordUnusedByTextFields({ key, ...modifiers }, 'darwin')).toBe(false)
    }
  })

  it.each([
    [{ ctrlKey: true, shiftKey: true }],
    [{ ctrlKey: true, altKey: true }],
    [{ metaKey: true, altKey: true }]
  ])('releases macOS chord %o that text fields ignore', (modifiers) => {
    for (const key of ['ArrowUp', 'ArrowDown']) {
      expect(isArrowChordUnusedByTextFields({ key, ...modifiers }, 'darwin')).toBe(true)
    }
  })

  it.each(['win32', 'linux'] as const)('splits Windows and Linux chords on %s', (platform) => {
    for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true }]) {
      expect(isArrowChordUnusedByTextFields({ key: 'ArrowUp', ...modifiers }, platform)).toBe(false)
    }
    expect(
      isArrowChordUnusedByTextFields({ key: 'ArrowDown', ctrlKey: true, shiftKey: true }, platform)
    ).toBe(false)
    for (const modifiers of [
      { altKey: true },
      { ctrlKey: true, altKey: true },
      { metaKey: true }
    ]) {
      expect(isArrowChordUnusedByTextFields({ key: 'ArrowDown', ...modifiers }, platform)).toBe(
        true
      )
    }
  })

  it('never releases keys other than vertical arrows', () => {
    for (const key of ['ArrowLeft', 'Home', 'b', 'Enter']) {
      expect(isArrowChordUnusedByTextFields({ key, ctrlKey: true, altKey: true }, 'darwin')).toBe(
        false
      )
    }
  })
})
