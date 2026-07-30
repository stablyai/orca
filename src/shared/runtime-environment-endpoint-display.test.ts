import { describe, expect, it } from 'vitest'
import {
  getPreferredPublicRuntimeEndpoint,
  getRuntimeEndpointTransportKind
} from './runtime-environment-endpoint-display'
import type { PublicKnownRuntimeEnvironment } from './runtime-environments'

function makeEnvironment(
  overrides?: Partial<PublicKnownRuntimeEnvironment>
): PublicKnownRuntimeEnvironment {
  return {
    id: 'env-1',
    name: 'desk',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'ws-1',
    endpoints: [
      {
        id: 'ws-1',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://192.168.1.10:6768'
      }
    ],
    ...overrides
  }
}

describe('getPreferredPublicRuntimeEndpoint', () => {
  it('prefers preferredEndpointId over the first list entry', () => {
    const environment = makeEnvironment({
      preferredEndpointId: 'ws-2',
      endpoints: [
        {
          id: 'ws-1',
          kind: 'websocket',
          label: 'LAN',
          endpoint: 'ws://192.168.1.10:6768'
        },
        {
          id: 'ws-2',
          kind: 'websocket',
          label: 'Tailscale',
          endpoint: 'ws://100.64.0.5:6768'
        }
      ]
    })
    expect(getPreferredPublicRuntimeEndpoint(environment)).toBe('ws://100.64.0.5:6768')
  })

  it('falls back to the first endpoint when preferred is missing', () => {
    const environment = makeEnvironment({ preferredEndpointId: 'missing' })
    expect(getPreferredPublicRuntimeEndpoint(environment)).toBe('ws://192.168.1.10:6768')
  })
})

describe('getRuntimeEndpointTransportKind', () => {
  it('classifies Tailscale endpoints', () => {
    expect(getRuntimeEndpointTransportKind('ws://100.64.0.5:6768')).toBe('tailscale')
    expect(getRuntimeEndpointTransportKind('wss://box.tailnet.ts.net')).toBe('tailscale')
  })

  it('classifies non-Tailscale endpoints as direct', () => {
    expect(getRuntimeEndpointTransportKind('ws://192.168.1.10:6768')).toBe('direct')
    expect(getRuntimeEndpointTransportKind('wss://orca.example.com')).toBe('direct')
    expect(getRuntimeEndpointTransportKind(null)).toBe('direct')
  })
})
