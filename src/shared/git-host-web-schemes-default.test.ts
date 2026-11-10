import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'

describe('getDefaultSettings', () => {
  it('defaults git host web schemes empty so ssh remotes keep https until overridden', () => {
    expect(getDefaultSettings('/tmp').gitHostWebSchemes).toEqual({})
  })
})
