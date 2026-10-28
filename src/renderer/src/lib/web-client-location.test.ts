import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWebClientLocation } from './web-client-location'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isWebClientLocation', () => {
  // Partial window.location must return safely; routing callers swallow throws into silent failed launches.
  it('does not throw when window exists without a location', () => {
    vi.stubGlobal('window', { api: {} })
    expect(() => isWebClientLocation()).not.toThrow()
    expect(isWebClientLocation()).toBe(false)
  })

  it('does not throw when location exists without a pathname', () => {
    vi.stubGlobal('window', { location: {} })
    expect(() => isWebClientLocation()).not.toThrow()
    expect(isWebClientLocation()).toBe(false)
  })

  it('detects the web client by its global marker', () => {
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true, location: { pathname: '/' } })
    expect(isWebClientLocation()).toBe(true)
  })
})
