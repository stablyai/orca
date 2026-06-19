import { describe, expect, it } from 'vitest'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getDropIndicatorClasses,
  getTabRootStateClasses,
  getTabStripBorderClasses
} from './drop-indicator'

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

describe('ACTIVE_TAB_INDICATOR_CLASSES', () => {
  it('renders a neutral 2px bottom-edge marker without shifting layout', () => {
    expect(ACTIVE_TAB_INDICATOR_CLASSES).toContain('absolute')
    expect(ACTIVE_TAB_INDICATOR_CLASSES).toContain('bottom-0')
    expect(ACTIVE_TAB_INDICATOR_CLASSES).toContain('h-[2px]')
    expect(ACTIVE_TAB_INDICATOR_CLASSES).toContain(
      'bg-[color-mix(in_srgb,var(--foreground)_60%,var(--card))]'
    )
    expect(ACTIVE_TAB_INDICATOR_CLASSES).toContain('pointer-events-none')
    expect(ACTIVE_TAB_INDICATOR_CLASSES).not.toContain('-top-px')
    expect(ACTIVE_TAB_INDICATOR_CLASSES).not.toContain('bg-[#1e3d9c]')
  })
})

describe('getTabStripBorderClasses', () => {
  it('includes top and right borders by default', () => {
    expect(getTabStripBorderClasses(true)).toBe('border-t border-r border-border')
    expect(getTabStripBorderClasses(false)).toBe('border-t border-border')
  })

  it('can omit the top border for rounded floating panel titlebars', () => {
    expect(getTabStripBorderClasses(true, { includeTopBorder: false })).toBe(
      'border-r border-border'
    )
    expect(getTabStripBorderClasses(false, { includeTopBorder: false })).toBe('border-border')
  })
})

describe('getTabRootStateClasses', () => {
  it('returns the shared selected-tab surface treatment', () => {
    const classes = getTabRootStateClasses(true)
    expect(classes).toContain('bg-[color-mix(in_srgb,var(--foreground)_6%,var(--card))]')
    expect(classes).toContain('text-foreground')
    expect(classes).not.toContain('hover:text-foreground')
  })

  it('returns the shared inactive-tab surface treatment', () => {
    const classes = getTabRootStateClasses(false)
    expect(classes).toContain('bg-card')
    expect(classes).toContain('text-muted-foreground')
    expect(classes).toContain('hover:text-foreground')
  })
})
