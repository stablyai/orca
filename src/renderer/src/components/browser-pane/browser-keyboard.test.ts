import { describe, expect, it } from 'vitest'
import { isEditableKeyboardTarget } from './browser-keyboard'

describe('isEditableKeyboardTarget', () => {
  it('returns true for input elements', () => {
    const input = {
      isContentEditable: false,
      closest: (selector: string) => (selector.includes('input') ? {} : null)
    }
    expect(isEditableKeyboardTarget(input)).toBe(true)
  })

  it('returns true for descendants inside editable hosts', () => {
    const child = {
      isContentEditable: false,
      closest: (selector: string) => (selector.includes('[contenteditable="true"]') ? {} : null)
    }
    expect(isEditableKeyboardTarget(child)).toBe(true)
  })

  it('returns false for non-editable elements', () => {
    const div = {
      isContentEditable: false,
      closest: () => null
    }
    expect(isEditableKeyboardTarget(div)).toBe(false)
  })
})
