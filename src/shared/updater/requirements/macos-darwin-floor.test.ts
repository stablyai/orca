import { describe, expect, it } from 'vitest'
import { darwinVersionForMacos } from './macos-darwin-floor'

describe('darwinVersionForMacos', () => {
  it('refuses a minor floor instead of truncating it and offering the update to older Macs', () => {
    expect(() => darwinVersionForMacos('15.4')).toThrow('no exact Darwin floor')
    expect(() => darwinVersionForMacos('13.0.1')).toThrow('no exact Darwin floor')
  })
})
