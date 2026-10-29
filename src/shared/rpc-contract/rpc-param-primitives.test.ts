import { describe, expect, it } from 'vitest'
import { requiredNumber, requiredString, requiredStringAllowingEmpty } from './rpc-param-primitives'

describe('required RPC primitive schemas', () => {
  it.each([requiredString, requiredStringAllowingEmpty, requiredNumber])(
    'reuses schemas for the same message without conflating different messages',
    (factory) => {
      const first = factory('Missing id')
      expect(factory('Missing id') === first).toBe(true)
      expect(factory('Missing name') === first).toBe(false)
    }
  )

  it('keeps each factory distinct for an identical message', () => {
    const strict = requiredString('Missing value')
    const empty = requiredStringAllowingEmpty('Missing value')
    const number = requiredNumber('Missing value')
    expect(strict.safeParse('').success).toBe(false)
    expect(empty.parse('')).toBe('')
    expect(empty.safeParse(1).success).toBe(false)
    expect(number.parse(1)).toBe(1)
    expect(number.safeParse('1').success).toBe(false)
  })
})
