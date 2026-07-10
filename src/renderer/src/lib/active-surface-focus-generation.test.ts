import { describe, expect, it } from 'vitest'
import {
  beginActiveSurfaceFocus,
  isActiveSurfaceFocusCurrent
} from './active-surface-focus-generation'

describe('active-surface-focus-generation', () => {
  it('keeps the most recent token current and supersedes older ones', () => {
    const first = beginActiveSurfaceFocus()
    expect(isActiveSurfaceFocusCurrent(first)).toBe(true)

    const second = beginActiveSurfaceFocus()
    // A newer request supersedes the earlier one.
    expect(isActiveSurfaceFocusCurrent(first)).toBe(false)
    expect(isActiveSurfaceFocusCurrent(second)).toBe(true)
  })

  it('hands out strictly increasing tokens', () => {
    const a = beginActiveSurfaceFocus()
    const b = beginActiveSurfaceFocus()
    expect(b).toBeGreaterThan(a)
  })
})
