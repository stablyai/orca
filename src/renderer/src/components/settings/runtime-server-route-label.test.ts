import { describe, expect, it } from 'vitest'
import { getRuntimeServerRouteLabel } from './runtime-environment-host-details'

describe('getRuntimeServerRouteLabel', () => {
  it('names the Relay route regardless of the advertised address', () => {
    expect(getRuntimeServerRouteLabel('relay', 'ws://127.0.0.1:6768')).toBe('Orca Relay')
  })

  it.each([
    ['ws://100.64.1.20:6768', 'Direct · Tailscale'],
    ['ws://192.168.1.20:6768', 'Direct · LAN'],
    ['wss://orca.example.com/runtime', 'Direct'],
    ['ws://127.0.0.1:6768', 'Direct']
  ])('labels a direct connection to %s as %s', (endpoint, label) => {
    expect(getRuntimeServerRouteLabel('direct', endpoint)).toBe(label)
  })

  it('shows nothing before a connection has reported its route', () => {
    expect(getRuntimeServerRouteLabel(undefined, 'ws://192.168.1.20:6768')).toBeNull()
  })
})
