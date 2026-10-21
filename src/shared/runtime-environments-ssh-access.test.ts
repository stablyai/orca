import { describe, expect, it } from 'vitest'
import { PAIRING_OFFER_VERSION, type PairingOffer } from './pairing'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  getRuntimeSshAccess,
  KnownRuntimeEnvironmentSchema,
  redactRuntimeEnvironment,
  RuntimeEnvironmentStoreSchema,
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
  it('keeps old stored environments valid without adding an SSH dependency', () => {
    const original = environment()
    const restored = RuntimeEnvironmentStoreSchema.parse({ version: 1, environments: [original] })
      .environments[0]!
    expect(restored).toEqual(original)
    expect(getRuntimeSshAccess(KnownRuntimeEnvironmentSchema.parse(restored))).toBeUndefined()
    expect(restored).not.toHaveProperty('sshAccess')
    // The persisted envelope never carries sidecar state, even when handed a linked environment.
    const persisted = RuntimeEnvironmentStoreSchema.parse({
      version: 1,
      environments: [accessEnvironment()]
    }).environments[0]!
    expect(persisted).not.toHaveProperty('sshAccess')
  })

  it.each([
    { sshTargetId: '' },
    { sshTargetGeneration: 0 },
    { sshTargetGeneration: 1.5 },
    { localPort: 0 },
    { localPort: 65536 },
    { remotePort: 0 },
    { remotePort: 65536 }
  ])('rejects malformed generic access links: %j', (change) => {
    expect(
      KnownRuntimeEnvironmentSchema.safeParse({
        ...accessEnvironment(),
        sshAccess: { ...accessLink, ...change }
      }).success
    ).toBe(false)
  })

  it('preserves SSH metadata while redacting the same pairing secrets', () => {
    const accessed = KnownRuntimeEnvironmentSchema.parse(accessEnvironment())
    const redacted = redactRuntimeEnvironment(accessed)
    expect(getRuntimeSshAccess(redacted)).toEqual(accessLink)
    expect(redacted.endpoints[0]).not.toHaveProperty('deviceToken')
    expect(redacted.endpoints[0]).not.toHaveProperty('publicKeyB64')
    expect(JSON.stringify(redacted)).not.toContain('secret-')
    expect(getPreferredPairingOffer(accessed)).toEqual(offer)
  })

  it.each([
    { endpointId: 'missing' },
    { previousPreferredEndpointId: 'missing' },
    { previousPreferredEndpointId: 'ssh-access' },
    { localPort: 46769 }
  ])('rejects access links that cannot restore the prior endpoint: %j', (change) => {
    expect(
      KnownRuntimeEnvironmentSchema.safeParse({
        ...accessEnvironment(),
        sshAccess: { ...accessLink, ...change }
      }).success
    ).toBe(false)
  })

  it('rejects an unpreferred SSH access endpoint', () => {
    expect(
      KnownRuntimeEnvironmentSchema.safeParse({
        ...accessEnvironment(),
        preferredEndpointId: accessLink.previousPreferredEndpointId
      }).success
    ).toBe(false)
  })

  it('rejects a non-loopback SSH access endpoint', () => {
    const accessed = accessEnvironment()
    accessed.endpoints[1]!.endpoint = 'ws://remote.example:46768'
    expect(KnownRuntimeEnvironmentSchema.safeParse(accessed).success).toBe(false)
  })

  it('rejects a generic access link without its SSH dependency', () => {
    expect(
      KnownRuntimeEnvironmentSchema.safeParse({
        ...accessEnvironment(),
        connectionDependency: undefined
      }).success
    ).toBe(false)
  })

  it('rejects a non-WebSocket loopback endpoint', () => {
    const accessed = accessEnvironment()
    accessed.endpoints[1]!.endpoint = 'https://127.0.0.1:46768'
    expect(KnownRuntimeEnvironmentSchema.safeParse(accessed).success).toBe(false)
  })
})
