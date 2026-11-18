import { describe, expect, it } from 'vitest'
import '../pairing/pairing'
import { PAIRING_OFFER_VERSION, type PairingOffer } from '../pairing/mobile-relay-pairing-offer'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  getRuntimeSshAccess,
  KnownRuntimeEnvironmentSchema,
  redactRuntimeEnvironment,
  type RuntimeSshTunnelLink
} from './runtime-environments'

const link: RuntimeSshTunnelLink = {
  sshTargetId: 'ssh-host',
  sshTargetGeneration: 7,
  localPort: 46768,
  remotePort: 6768
}
const accessLink = {
  ...link,
  endpointId: 'ssh-access',
  previousPreferredEndpointId: 'ws-environment-1'
}
const offer: PairingOffer = {
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768',
  deviceToken: 'secret-device-token',
  publicKeyB64: 'secret-key',
  pairedDeviceId: 'paired-device'
}
function accessEnvironment() {
  const original = environment()
  return {
    ...original,
    connectionDependency: 'ssh-tunnel' as const,
    sshAccess: accessLink,
    endpoints: [...original.endpoints, { ...original.endpoints[0]!, id: accessLink.endpointId }],
    preferredEndpointId: accessLink.endpointId
  }
}
function environment() {
  return createEnvironmentFromPairingOffer({
    id: 'environment-1',
    name: 'Host',
    now: 1,
    offer,
    runtimeId: 'host-runtime'
  })
}

describe('runtime SSH access without deployment ownership', () => {
  it('preserves SSH metadata while redacting the same pairing secrets', () => {
    const accessed = KnownRuntimeEnvironmentSchema.parse(accessEnvironment())
    const redacted = redactRuntimeEnvironment(accessed)
    expect(getRuntimeSshAccess(redacted)).toEqual(accessLink)
    expect(redacted.endpoints[0]).not.toHaveProperty('deviceToken')
    expect(redacted.endpoints[0]).not.toHaveProperty('publicKeyB64')
    expect(JSON.stringify(redacted)).not.toContain('secret-')
    expect(getPreferredPairingOffer(accessed)).toEqual(offer)
  })
})
