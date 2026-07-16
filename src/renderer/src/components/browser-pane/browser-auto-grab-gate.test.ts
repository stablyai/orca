import { describe, expect, it } from 'vitest'
import { shouldGrabOnCopyShortcut } from './browser-auto-grab-gate'

// The base case: focus on non-editable page content, markup overlay closed,
// and the grab keybinding matched. Grab should fire only when Auto Grab is on.
const armed = {
  autoGrabEnabled: true,
  isEditableTarget: false,
  markupActive: false,
  matchesGrabKeybinding: true
}

describe('shouldGrabOnCopyShortcut', () => {
  it('arms grab when Auto Grab is enabled and the chord matches', () => {
    expect(shouldGrabOnCopyShortcut(armed)).toBe(true)
  })

  it('never arms grab when Auto Grab is disabled (default off)', () => {
    expect(shouldGrabOnCopyShortcut({ ...armed, autoGrabEnabled: false })).toBe(false)
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
