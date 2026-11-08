import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../../../src/main/runtime/rpc/server/pairing/device-registry'
import { usesOlderPairingMethod } from '../../../src/main/runtime/rpc/server/pairing/pairing-ticket-exchange'
import '../../../src/shared/remote-runtime/pairing/ticket-exchange-capability'
import '../../../src/shared/remote-runtime/pairing/pairing'
import '../../../src/shared/remote-runtime/pairing/remote-pairing-ticket-exchange'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

// Single-use pairing must survive a downgrade, accept rows an older host made, and stay invisible to old clients.
const SUITE_TIMEOUT_MS = 180_000
const EXCHANGED = 'e'.repeat(48)

type ReleasedRegistryLike = {
  addDevice(name: string, scope: 'mobile' | 'runtime'): { deviceId: string; token: string }
  validateToken(token: string): { deviceId: string } | null
  updateLastSeen(deviceId: string): void
}

let ReleasedRegistry: new (userDataPath: string) => ReleasedRegistryLike

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const registryModule = await importReleaseCheckoutModule(
    checkout,
    'src/main/runtime/rpc/server/pairing/device-registry.ts'
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's DeviceRegistry class; a changed shape fails the assertions below.
  ReleasedRegistry = registryModule.DeviceRegistry as typeof ReleasedRegistry
}, SUITE_TIMEOUT_MS)

function pairedTicket(registry: DeviceRegistry, name: string) {
  const offer = registry.getOrCreatePendingDevice(name, 'mobile')
  registry.updateLastSeen(offer.deviceId)
  return offer
}

describe('cross-version: single-use pairing tickets', () => {
  it('after a downgrade, exchanged phones keep their own token and older phones their code', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-xv-ticket-'))
    const current = new DeviceRegistry(userDataPath)
    const exchanged = pairedTicket(current, 'New phone')
    current.exchangePairingTicket(exchanged.deviceId, exchanged.token, EXCHANGED)
    current.validateToken(EXCHANGED)
    const older = pairedTicket(current, 'Old phone')

    const released = new ReleasedRegistry(userDataPath)
    expect(released.validateToken(EXCHANGED)?.deviceId).toBe(exchanged.deviceId)
    expect(released.validateToken(exchanged.token)).toBeNull()
    expect(released.validateToken(older.token)?.deviceId).toBe(older.deviceId)
    // The released host rewrites the file; upgrading again keeps both working.
    released.updateLastSeen(older.deviceId)

    const upgraded = new DeviceRegistry(userDataPath)
    expect(upgraded.validateToken(EXCHANGED)?.deviceId).toBe(exchanged.deviceId)
    expect(upgraded.validateToken(older.token)?.deviceId).toBe(older.deviceId)
  })

  it('rows an older host minted keep working and are never treated as single-use', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-xv-ticket-'))
    const released = new ReleasedRegistry(userDataPath)
    const phone = released.addDevice('Phone', 'mobile')
    released.updateLastSeen(phone.deviceId)

    const current = new DeviceRegistry(userDataPath)
    expect(current.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
    expect(() => current.exchangePairingTicket(phone.deviceId, phone.token, EXCHANGED)).toThrow(
      'not_a_ticket'
    )
    expect(current.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
    // The desktop can't tell which app made it, so it never asks anyone to update.
    expect(usesOlderPairingMethod(current.getDevice(phone.deviceId)!, current.listDevices())).toBe(
      false
    )
  })
})
