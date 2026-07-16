import { describe, expect, it } from 'vitest'
import { shouldGrabOnCopyShortcut } from './browser-auto-grab-gate'

// The base case: focus on non-editable page content, markup overlay closed,
// and the grab keybinding matched. Callers only reach the gate with Auto Grab on.
const armed = {
  isEditableTarget: false,
  markupActive: false,
  matchesGrabKeybinding: true
}

describe('shouldGrabOnCopyShortcut', () => {
  it('arms grab when the chord matches on plain page content', () => {
    expect(shouldGrabOnCopyShortcut(armed)).toBe(true)
  })

  it('lets native copy through in editable targets', () => {
    expect(shouldGrabOnCopyShortcut({ ...armed, isEditableTarget: true })).toBe(false)
  })

  it('does not arm while the markup overlay is active', () => {
    expect(shouldGrabOnCopyShortcut({ ...armed, markupActive: true })).toBe(false)
  })

  it('does not arm when the chord does not match the grab keybinding', () => {
    expect(shouldGrabOnCopyShortcut({ ...armed, matchesGrabKeybinding: false })).toBe(false)
  })
})
