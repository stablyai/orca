import { describe, expect, it } from 'vitest'
import { isGhAccountBindingEnforced } from './repository-github-account'

describe('isGhAccountBindingEnforced', () => {
  it('requires an echoed normalized binding for enforcement', () => {
    expect(
      isGhAccountBindingEnforced(
        { host: 'github.com', user: 'Alice' },
        { host: 'github.com', user: 'Alice' }
      )
    ).toBe(true)
    expect(isGhAccountBindingEnforced({ host: 'github.com', user: 'Alice' }, undefined)).toBe(false)
    expect(isGhAccountBindingEnforced(null, undefined)).toBe(true)
    expect(isGhAccountBindingEnforced(null, null)).toBe(true)
    expect(isGhAccountBindingEnforced(null, { host: 'github.com', user: 'Alice' })).toBe(false)
  })
})
