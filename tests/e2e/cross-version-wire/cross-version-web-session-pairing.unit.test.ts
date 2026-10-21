import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { beforeAll, describe, expect, it } from 'vitest'
import { DeviceRegistry, type DeviceEntry } from '../../../src/main/runtime/device-registry'
import { DEVICE_REGISTRY_FILENAME } from '../../../src/main/runtime/mobile-pairing-files'
import { DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY } from '../../../src/shared/device-key-capability'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

/**
 * Session-only browser keys add an `ephemeral` flag to keyed rows. A released host (desktop
 * downgrade) must keep such rows, keep token rows authenticating, and never advertise the
 * capability that makes a browser send `ephemeral` to it.
 */
// The last release without session-only keys; a newer baseline would itself drop the row.
const PRE_EPHEMERAL_REF = 'v1.4.224'
const SUITE_TIMEOUT_MS = 180_000

type RegistryLike = {
  validateToken(token: string): { deviceId: string } | null
  updateLastSeen(deviceId: string): void
}

let ReleasedRegistry: new (userDataPath: string) => RegistryLike
let releasedCapabilities: readonly string[]

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(PRE_EPHEMERAL_REF)
  const [registryModule, protocolModule] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/main/runtime/device-registry.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/protocol-version.ts')
  ])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's DeviceRegistry class; a changed shape fails the assertions below.
  ReleasedRegistry = registryModule.DeviceRegistry as typeof ReleasedRegistry
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's capability list; a changed shape fails the assertion below.
  releasedCapabilities = protocolModule.RUNTIME_CAPABILITIES as readonly string[]
}, SUITE_TIMEOUT_MS)

describe('cross-version: session-only browser rows', () => {
  it('a released host never invites a browser to send ephemeral', () => {
    expect(releasedCapabilities).not.toContain(DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY)
  })

  it('a released registry keeps the session row and token rows; this host drops it on restart', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-xv-web-session-'))
    const current = new DeviceRegistry(userDataPath)
    const legacy = current.addDevice('Browser', 'runtime')
    current.updateLastSeen(legacy.deviceId)
    const keyB64 = Buffer.from(nacl.sign.keyPair().publicKey).toString('base64')
    const session = current.forkDeviceKey(legacy.deviceId, keyB64, 'Tab', { ephemeral: true })

    const released = new ReleasedRegistry(userDataPath)
    expect(released.validateToken(legacy.token)?.deviceId).toBe(legacy.deviceId)
    released.updateLastSeen(legacy.deviceId)
    const rows: DeviceEntry[] = JSON.parse(
      readFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), 'utf8')
    )
    expect(rows.find((row) => row.deviceId === session.deviceId)).toMatchObject({
      ephemeral: true,
      devicePublicKeyB64: keyB64
    })
    expect(rows.find((row) => row.deviceId === session.deviceId)?.token).toBeUndefined()

    const restarted = new DeviceRegistry(userDataPath)
    expect(restarted.getDevice(session.deviceId)).toBeNull()
    expect(restarted.validateToken(legacy.token)?.deviceId).toBe(legacy.deviceId)
  })
})
