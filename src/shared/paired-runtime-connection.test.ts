import { describe, expect, it } from 'vitest'
import {
  pairedRuntimeConnectionFromOffer,
  pairedRuntimeConnectionToken
} from './paired-runtime-connection'
import { PAIRING_OFFER_VERSION } from './pairing'
import { getPreferredPairedRuntimeConnection } from './runtime-environments'

describe('paired runtime connection handle', () => {
  it('carries an offer’s endpoint, pinned host key and token credential', () => {
    const connection = pairedRuntimeConnectionFromOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'device-token',
      publicKeyB64: 'host-key',
      pairedDeviceId: 'device-1',
      scope: 'runtime'
    })
    expect(connection).toEqual({
      endpoint: 'ws://127.0.0.1:6768',
      hostPublicKeyB64: 'host-key',
      credential: { kind: 'token', deviceToken: 'device-token' },
      pairedDeviceId: 'device-1'
    })
    expect(pairedRuntimeConnectionToken(connection)).toBe('device-token')
  })

  it('omits pairedDeviceId when the offer has none', () => {
    const connection = pairedRuntimeConnectionFromOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://h:1',
      deviceToken: 't',
      publicKeyB64: 'k'
    })
    expect('pairedDeviceId' in connection).toBe(false)
  })

  it('builds the handle from an environment’s preferred endpoint', () => {
    const connection = getPreferredPairedRuntimeConnection({
      name: 'Env',
      pairedDeviceId: 'device-2',
      preferredEndpointId: 'b',
      endpoints: [endpointFixture('a'), endpointFixture('b')]
    })
    expect(connection).toEqual({
      endpoint: 'ws://b',
      hostPublicKeyB64: 'kb',
      credential: { kind: 'token', deviceToken: 'tb' },
      pairedDeviceId: 'device-2'
    })
  })
})

function endpointFixture(id: string) {
  return {
    id,
    kind: 'websocket' as const,
    label: id,
    endpoint: `ws://${id}`,
    deviceToken: `t${id}`,
    publicKeyB64: `k${id}`
  }
}
