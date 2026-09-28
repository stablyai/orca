import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWebClientLocation } from './web-client-location'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isWebClientLocation', () => {
  it('reports false when there is no window at all', () => {
    vi.stubGlobal('window', undefined)
    expect(isWebClientLocation()).toBe(false)
  })

  // Why: this runs on the launch-routing path, where a throw is swallowed and
  // silently becomes a failed launch. A window without a usable `location`
  // must answer the question, not throw.
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

  it('detects the web client by its entry path', () => {
    vi.stubGlobal('window', { location: { pathname: '/web-index.html' } })
    expect(isWebClientLocation()).toBe(true)
  })

  it('detects the web client by its global marker', () => {
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true, location: { pathname: '/' } })
    expect(isWebClientLocation()).toBe(true)
  })

  it('reports false for a normal desktop renderer path', () => {
    vi.stubGlobal('window', { location: { pathname: '/index.html' } })
    expect(isWebClientLocation()).toBe(false)
  })
})
