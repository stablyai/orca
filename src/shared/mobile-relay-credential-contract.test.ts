import { describe, expect, it } from 'vitest'
import {
  PairingGetDirectEndpointsResultSchema,
  PairingGetEndpointsResultSchema
} from './mobile-relay-credential-contract'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

describe('pairing endpoint contract', () => {
  it('keeps getEndpoints v1 strict so extra LAN keys fail old-phone resume-confirm', () => {
    expect(
      PairingGetEndpointsResultSchema.safeParse({
        v: 1,
        relay,
        selected: { kind: 'lan', url: 'ws://192.168.1.10:6768' },
        endpoints: [{ kind: 'lan', url: 'ws://192.168.1.10:6768' }]
      }).success
    ).toBe(false)
    expect(PairingGetEndpointsResultSchema.parse({ v: 1, relay })).toEqual({ v: 1, relay })
  })

  it('accepts a ranked getDirectEndpoints v1 payload', () => {
    const selected = { kind: 'tailscale' as const, url: 'ws://100.64.0.2:6768' }
    expect(
      PairingGetDirectEndpointsResultSchema.parse({
        v: 1,
        selected,
        endpoints: [selected, { kind: 'lan', url: 'ws://192.168.1.20:6768' }]
      })
    ).toEqual({
      v: 1,
      selected,
      endpoints: [selected, { kind: 'lan', url: 'ws://192.168.1.20:6768' }]
    })
  })
})
