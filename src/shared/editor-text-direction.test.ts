import { describe, expect, it } from 'vitest'

import {
  nextEditorTextDirectionOverride,
  resolveEditorTextDirection
} from './editor-text-direction'

describe('resolveEditorTextDirection', () => {
  it('falls back to ltr for profiles saved before the preference existed', () => {
    expect(resolveEditorTextDirection(undefined, undefined)).toBe('ltr')
  })

  it('ignores a corrupted persisted value instead of passing it to CSS', () => {
    expect(resolveEditorTextDirection('sideways' as never, undefined)).toBe('ltr')
  })

  it('uses the global default when the file has no override', () => {
    expect(resolveEditorTextDirection('auto', undefined)).toBe('auto')
    expect(resolveEditorTextDirection('rtl', undefined)).toBe('rtl')
  })

  it('lets a per-file override win over the global default', () => {
    expect(resolveEditorTextDirection('rtl', 'ltr')).toBe('ltr')
    expect(resolveEditorTextDirection('auto', 'rtl')).toBe('rtl')
  })
})

describe('nextEditorTextDirectionOverride', () => {
  it('round-trips between ltr and rtl', () => {
    expect(nextEditorTextDirectionOverride('ltr')).toBe('rtl')
    expect(nextEditorTextDirectionOverride('rtl')).toBe('ltr')
  })

  it('commits auto to rtl, since a user reaching for the toggle wants the RTL case', () => {
    expect(nextEditorTextDirectionOverride('auto')).toBe('rtl')
  })
})
