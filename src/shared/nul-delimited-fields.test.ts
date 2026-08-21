import { describe, expect, it } from 'vitest'
import { iterateNulDelimitedFields } from './nul-delimited-fields'

describe('iterateNulDelimitedFields', () => {
  it('preserves empty and trailing fields without materializing a split array', () => {
    expect([...iterateNulDelimitedFields('one\0\0three\0')]).toEqual(['one', '', 'three', ''])
  })
})
