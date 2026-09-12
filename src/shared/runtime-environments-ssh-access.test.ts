import { describe, expect, it } from 'vitest'
import { PAIRING_OFFER_VERSION, type PairingOffer } from './pairing'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  getRuntimeSshAccess,
  isManagedOrcadRuntimeEnvironment,
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
    expect(getRuntimeSshAccess(restored)).toBeUndefined()
    expect(restored).not.toHaveProperty('sshAccess')
    expect(isManagedOrcadRuntimeEnvironment(restored)).toBe(false)
  })

  it('preserves legacy managed deployment access and classification', () => {
    const managed = KnownRuntimeEnvironmentSchema.parse({
      ...environment(),
      connectionDependency: 'ssh-tunnel',
      orcadDeployment: link
    })
    expect(getRuntimeSshAccess(managed)).toEqual(link)
    expect(isManagedOrcadRuntimeEnvironment(managed)).toBe(true)
  })

  it('adds access to the same paired host without granting managed lifecycle ownership', () => {
    const accessed = KnownRuntimeEnvironmentSchema.parse(accessEnvironment())
    expect(getRuntimeSshAccess(accessed)).toEqual(accessLink)
    expect(isManagedOrcadRuntimeEnvironment(accessed)).toBe(false)
    expect(accessed.runtimeId).toBe('host-runtime')
    expect(accessed.pairedDeviceId).toBe('paired-device')
    expect(getPreferredPairingOffer(accessed)).toEqual(offer)
    expect(accessed).not.toHaveProperty('orcadDeployment')
    expect(KnownRuntimeEnvironmentSchema.parse(JSON.parse(JSON.stringify(accessed)))).toEqual(
      accessed
    )
  })

  it('accepts matching links and preserves managed-link precedence', () => {
    const dual = KnownRuntimeEnvironmentSchema.parse({
      ...accessEnvironment(),
      orcadDeployment: link,
      sshAccess: { ...accessLink }
    })
    expect(getRuntimeSshAccess(dual)).toBe(dual.orcadDeployment)
    expect(isManagedOrcadRuntimeEnvironment(dual)).toBe(true)
  })

  it.each([
    { sshTargetId: 'different-target' },
    { sshTargetGeneration: 8 },
    { localPort: 46769 },
    { remotePort: 6769 }
  ])('rejects conflicting dual access links: %j', (change) => {
    const conflicting = {
      ...accessEnvironment(),
      orcadDeployment: link,
      sshAccess: { ...accessLink, ...change }
    }
    expect(() => KnownRuntimeEnvironmentSchema.parse(conflicting)).toThrow('conflicts')
    expect(() => getRuntimeSshAccess(conflicting)).toThrow('conflicts')
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
    expect(isManagedOrcadRuntimeEnvironment(redacted)).toBe(false)
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
