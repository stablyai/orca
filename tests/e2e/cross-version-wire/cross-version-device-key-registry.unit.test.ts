import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { encodeDeviceProofMessage } from '../../../src/shared/device-key-proof'
import { DeviceRegistry } from '../../../src/main/runtime/device-registry'
import { SimulatedMobileE2EEV2Peer } from '../../../src/main/runtime/mobile-cloud-relay/simulated-mobile-e2ee-v2-peer'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

/**
 * Device keys add keyed rows (no token) to orca-devices.json and a key-auth shape inside E2EE v2.
 * A released build must keep keyed rows intact and inert, keep authenticating token rows, and
 * refuse key auth with bad_auth so an updated client can report "host downgraded" and keep its key.
 */
const SUITE_TIMEOUT_MS = 180_000

type RegistryLike = {
  validateToken(token: string): { deviceId: string } | null
  updateLastSeen(deviceId: string): void
  listDevices(): readonly Record<string, unknown>[]
}
type ChannelLike = { handleRawMessage(raw: string): void }

let ReleasedRegistry: new (userDataPath: string) => RegistryLike
let ReleasedChannel: new (ws: unknown, options: Record<string, unknown>) => ChannelLike

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const [registryModule, channelModule] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/main/runtime/device-registry.ts'),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/rpc/e2ee-channel.ts')
  ])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's DeviceRegistry class; a changed shape fails the assertions below.
  ReleasedRegistry = registryModule.DeviceRegistry as typeof ReleasedRegistry
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's E2EEChannel class; a changed shape fails the assertions below.
  ReleasedChannel = channelModule.E2EEChannel as typeof ReleasedChannel
}, SUITE_TIMEOUT_MS)

describe('cross-version: device keys against a released host', () => {
  it('a released registry keeps keyed rows intact and inert, and token rows working', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-xv-device-key-'))
    const current = new DeviceRegistry(userDataPath)
    const legacy = current.addDevice('Phone', 'mobile')
    current.updateLastSeen(legacy.deviceId)
    const keyB64 = Buffer.from(nacl.sign.keyPair().publicKey).toString('base64')
    const forked = current.forkDeviceKey(legacy.deviceId, keyB64, 'Phone (key)')

    const released = new ReleasedRegistry(userDataPath)
    expect(released.validateToken(legacy.token)?.deviceId).toBe(legacy.deviceId)
    expect(released.validateToken('undefined')).toBeNull()
    released.updateLastSeen(legacy.deviceId)

    const reread = new DeviceRegistry(userDataPath)
    expect(reread.getDevice(forked.deviceId)).toMatchObject({
      credentialKind: 'device-key',
      devicePublicKeyB64: keyB64,
      forkedFrom: legacy.deviceId
    })
    expect(reread.lookupDeviceKey(forked.deviceId)).toMatchObject({ kind: 'found' })
    expect(JSON.parse(readFileSync(join(userDataPath, 'orca-devices.json'), 'utf-8'))).toHaveLength(
      2
    )
  })

  it('a released host refuses key auth with bad_auth (not unauthorized)', () => {
    const desktop = nacl.box.keyPair()
    const sent: string[] = []
    const ws = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: (data: string) => sent.push(data),
      close: vi.fn()
    }
    const onError = vi.fn()
    const channel = new ReleasedChannel(ws, {
      serverSecretKey: desktop.secretKey,
      resolveAuthenticatedDevice: () => null,
      onReady: vi.fn(),
      onError
    })
    const peer = new SimulatedMobileE2EEV2Peer(nacl.box.keyPair(), desktop.publicKey, null)
    channel.handleRawMessage(JSON.stringify(peer.hello))
    expect(peer.acceptReady(JSON.parse(sent[0]!))).toBe(true)
    const key = nacl.sign.keyPair()
    const proof = nacl.sign.detached(
      encodeDeviceProofMessage('auth', Buffer.from(peer.transcriptHashB64, 'base64')),
      key.secretKey
    )
    channel.handleRawMessage(
      peer.sealText(
        JSON.stringify({
          type: 'e2ee_auth',
          v: 2,
          transcriptHashB64: peer.transcriptHashB64,
          deviceId: 'keyed',
          deviceProofB64: Buffer.from(proof).toString('base64')
        })
      )
    )
    expect(JSON.parse(peer.openText(sent[1]!)!)).toEqual({
      type: 'e2ee_error',
      error: { code: 'bad_auth' }
    })
    expect(onError).toHaveBeenCalledWith(4001, 'Invalid e2ee_auth')
  })

  it('old registry files load unchanged', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-xv-device-key-'))
    const released = new ReleasedRegistry(userDataPath)
    expect(released.listDevices()).toHaveLength(0)
    writeFileSync(
      join(userDataPath, 'orca-devices.json'),
      JSON.stringify([
        { deviceId: 'd', name: 'n', token: 't', scope: 'mobile', pairedAt: 1, lastSeenAt: 2 }
      ])
    )
    expect(new DeviceRegistry(userDataPath).validateToken('t')?.deviceId).toBe('d')
  })
})
