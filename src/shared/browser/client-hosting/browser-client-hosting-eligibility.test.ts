import { describe, expect, it } from 'vitest'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY
} from '../runtime/browser-runtime-capabilities'
import {
  BROWSER_CLIENT_HOSTING_RUNTIME_CAPABILITIES,
  expectsBrowserClientHosting
} from './browser-client-hosting-eligibility'

const CAPABLE = [
  ...BROWSER_CLIENT_HOSTING_RUNTIME_CAPABILITIES,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY
]

describe('expectsBrowserClientHosting', () => {
  it("lets a person's 'client' move override the setting, never the server's capabilities or a phone", () => {
    const serverSetting = { enabled: false, deviceScope: 'desktop', capabilities: CAPABLE }
    expect(expectsBrowserClientHosting({ ...serverSetting, preference: 'auto' })).toBe(false)
    expect(expectsBrowserClientHosting({ ...serverSetting, preference: 'client' })).toBe(true)
    expect(
      expectsBrowserClientHosting({
        ...serverSetting,
        preference: 'client',
        capabilities: CAPABLE.filter(
          (capability) => capability !== BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY
        )
      })
    ).toBe(false)
    expect(
      expectsBrowserClientHosting({ ...serverSetting, preference: 'client', deviceScope: 'mobile' })
    ).toBe(false)
  })
})
