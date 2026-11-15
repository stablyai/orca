import { describe, expect, it } from 'vitest'
import { tailscaleHostOfEndpoint, tailscalePingCommand } from './remote-runtime-tailscale-hint'

describe('tailscaleHostOfEndpoint', () => {
  it('returns a pasteable host only when it is plain DNS or IP syntax', () => {
    expect(tailscaleHostOfEndpoint('ws://desk.tail1234.ts.net:6768')).toBe('desk.tail1234.ts.net')
    expect(tailscaleHostOfEndpoint('ws://[fd7a:115c:a1e0::1]:6768')).toBe('fd7a:115c:a1e0::1')
    expect(tailscaleHostOfEndpoint('ws://$(id).ts.net:6768')).toBeNull()
    expect(tailscalePingCommand('100.101.102.103')).toBe('tailscale ping 100.101.102.103')
  })
})
