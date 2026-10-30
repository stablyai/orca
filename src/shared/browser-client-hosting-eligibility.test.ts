import { describe, expect, it } from 'vitest'
import {
  expectsBrowserClientHosting,
  runtimeAdvertisesBrowserClientHosting
} from './browser-client-hosting-eligibility'

const CLIENT_HOST_CAPABILITIES = [
  'browser.clientHost.v1',
  'browser.clientHost.pageMetadata.v1',
  'browser.clientHost.automation.v1',
  'network.browserTunnel.v1',
  'network.browserTunnel.executionHosts.v1'
]

const ELIGIBLE = {
  enabled: true,
  preference: 'auto' as const,
  deviceScope: 'desktop',
  capabilities: [...CLIENT_HOST_CAPABILITIES, 'browser.screencast.v1']
}

describe('expectsBrowserClientHosting', () => {
  it('accepts a desktop runtime that advertises the whole capability set', () => {
    expect(expectsBrowserClientHosting(ELIGIBLE)).toBe(true)
  })

  it('treats an unset preference as auto', () => {
    expect(expectsBrowserClientHosting({ ...ELIGIBLE, preference: undefined })).toBe(true)
  })

  it('hosts on this device when the server-render setting meets a server that cannot stream', () => {
    expect(
      expectsBrowserClientHosting({
        ...ELIGIBLE,
        enabled: false,
        capabilities: CLIENT_HOST_CAPABILITIES
      })
    ).toBe(true)
  })

  it.each([
    { name: 'client hosting is disabled', input: { enabled: false } },
    { name: 'the caller asked for a server page', input: { preference: 'server' as const } },
    { name: 'the runtime is a mobile device', input: { deviceScope: 'mobile' } },
    { name: 'the runtime advertises nothing', input: { capabilities: undefined } }
  ])('refuses when $name', ({ input }) => {
    expect(expectsBrowserClientHosting({ ...ELIGIBLE, ...input })).toBe(false)
  })

  it.each(CLIENT_HOST_CAPABILITIES)('refuses without %s', (missing) => {
    const capabilities = ELIGIBLE.capabilities.filter((capability) => capability !== missing)

    expect(runtimeAdvertisesBrowserClientHosting(capabilities)).toBe(false)
    expect(expectsBrowserClientHosting({ ...ELIGIBLE, capabilities })).toBe(false)
  })
})
