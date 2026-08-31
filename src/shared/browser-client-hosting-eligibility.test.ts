import { describe, expect, it } from 'vitest'
import {
  BROWSER_CLIENT_HOSTING_RUNTIME_CAPABILITIES,
  expectsBrowserClientHosting,
  runtimeAdvertisesBrowserClientHosting
} from './browser-client-hosting-eligibility'

const ELIGIBLE = {
  enabled: true,
  preference: 'auto' as const,
  deviceScope: 'desktop',
  capabilities: [...BROWSER_CLIENT_HOSTING_RUNTIME_CAPABILITIES, 'browser.screencast.v1']
}

describe('expectsBrowserClientHosting', () => {
  it('accepts a desktop runtime that advertises the whole capability set', () => {
    expect(expectsBrowserClientHosting(ELIGIBLE)).toBe(true)
  })

  it('treats an unset preference as auto', () => {
    expect(expectsBrowserClientHosting({ ...ELIGIBLE, preference: undefined })).toBe(true)
  })

  it.each([
    { name: 'client hosting is disabled', input: { enabled: false } },
    { name: 'the caller asked for a server page', input: { preference: 'server' as const } },
    { name: 'the runtime is a mobile device', input: { deviceScope: 'mobile' } },
    { name: 'the runtime advertises nothing', input: { capabilities: undefined } }
  ])('refuses when $name', ({ input }) => {
    expect(expectsBrowserClientHosting({ ...ELIGIBLE, ...input })).toBe(false)
  })

  // Why each capability gets its own case: the set is the contract between this client's guest
  // renderer and the runtime, and dropping any one of them leaves a host that cannot serve it.
  it.each(BROWSER_CLIENT_HOSTING_RUNTIME_CAPABILITIES)('refuses without %s', (missing) => {
    const capabilities = ELIGIBLE.capabilities.filter((capability) => capability !== missing)

    expect(runtimeAdvertisesBrowserClientHosting(capabilities)).toBe(false)
    expect(expectsBrowserClientHosting({ ...ELIGIBLE, capabilities })).toBe(false)
  })
})
