import { describe, expect, it } from 'vitest'
import { darwinVersionForMacos, macosVersionForDarwinFloor } from './macos-darwin-floor'

describe('darwinVersionForMacos', () => {
  it('refuses a minor floor instead of truncating it and offering the update to older Macs', () => {
    expect(() => darwinVersionForMacos('15.4')).toThrow('no exact Darwin floor')
    expect(() => darwinVersionForMacos('13.0.1')).toThrow('no exact Darwin floor')
  })

  it('gates macOS 13.4 on Darwin 22.5.0 so 13.3.x (Darwin 22.4) is held back', () => {
    expect(darwinVersionForMacos('13.4')).toBe('22.5.0')
    expect(macosVersionForDarwinFloor([22, 5, 0])).toBe('13.4')
  })
})
