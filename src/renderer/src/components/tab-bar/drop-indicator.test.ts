import { describe, expect, it } from 'vitest'
import { getDropIndicatorClasses } from './drop-indicator'

describe('getDropIndicatorClasses', () => {
  it('returns left pseudo-element classes for "left" indicator', () => {
    const classes = getDropIndicatorClasses('left')
    expect(classes).toContain('before:left-0')
    expect(classes).toContain('before:bg-blue-500')
    expect(classes).toContain('before:w-[2px]')
    expect(classes).toContain('before:absolute')
    expect(classes).toContain('before:inset-y-0')
    expect(classes).toContain('before:z-10')
  })

  it('returns right pseudo-element classes for "right" indicator', () => {
    const classes = getDropIndicatorClasses('right')
    expect(classes).toContain('after:right-0')
    expect(classes).toContain('after:bg-blue-500')
    expect(classes).toContain('after:w-[2px]')
    expect(classes).toContain('after:absolute')
    expect(classes).toContain('after:inset-y-0')
    expect(classes).toContain('after:z-10')
  })

  it('returns an empty string for null indicator', () => {
    expect(getDropIndicatorClasses(null)).toBe('')
  })

  it('uses before pseudo-element for left and after for right', () => {
    const left = getDropIndicatorClasses('left')
    const right = getDropIndicatorClasses('right')
    // Left uses before: prefix, right uses after: prefix
    expect(left).toMatch(/^before:/)
    expect(right).toMatch(/^after:/)
    expect(left).not.toContain('after:')
    expect(right).not.toContain('before:')
  })
})
