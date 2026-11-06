import { describe, expect, it } from 'vitest'
import { managedServerForgettable } from './managed-server-row-parts'

describe('managedServerForgettable', () => {
  it('offers Forget for a replaced server even while its host still answers (#37766)', () => {
    expect(managedServerForgettable({ statusError: null }, true)).toBe(true)
    expect(managedServerForgettable({ statusError: 'unreachable' }, false)).toBe(true)
    expect(managedServerForgettable({ statusError: null }, false)).toBe(false)
  })
})
