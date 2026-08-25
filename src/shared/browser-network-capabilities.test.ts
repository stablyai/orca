import { describe, expect, it } from 'vitest'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from './protocol-version'

describe('browser network capabilities', () => {
  it('keeps client hosting, network tunneling, and screencast independent', () => {
    expect(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY).toBe('browser.clientHost.v1')
    expect(BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY).toBe('network.browserTunnel.v1')
    expect(BROWSER_SCREENCAST_RUNTIME_CAPABILITY).toBe('browser.screencast.v1')
  })

  it('does not advertise unregistered client-host or tunnel implementations', () => {
    expect(RUNTIME_CAPABILITIES).not.toContain(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).not.toContain(BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).toContain(BROWSER_SCREENCAST_RUNTIME_CAPABILITY)
  })
})
