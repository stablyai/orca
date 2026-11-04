import { describe, expect, test } from 'vitest'
import { prepareReleaseFixtures } from './release-fixture-setup'

describe('historical fixture setup', () => {
  const failure = new Error('named extraction failure')
  const loaded: string[] = []
  const prepared = prepareReleaseFixtures(['unavailable-pin', 'usable-pin'], async (ref) => {
    loaded.push(ref)
    if (ref === 'unavailable-pin') {
      throw failure
    }
    return { ref }
  })

  test('finishes source preparation before assertions without losing another pin to a setup error', () => {
    expect(loaded).toEqual(['unavailable-pin', 'usable-pin'])
    expect(prepared('usable-pin')).toEqual({ ref: 'usable-pin' })
  })

  test('reports the original setup error only when its pin is consumed', () => {
    expect(() => prepared('unavailable-pin')).toThrow(failure)
    expect(loaded).toEqual(['unavailable-pin', 'usable-pin'])
  })
})
