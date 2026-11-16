import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  addOrUpdateEnvironmentFromPairingCode,
  listEnvironments,
  resolveEnvironmentPairingOffer
} from './runtime-environment-store-operations'

const serverKey = Buffer.alloc(32, 7).toString('base64')

function pairingCode(endpoint: string, deviceToken = 'first-token', publicKeyB64 = serverKey) {
  return encodePairingOffer({ v: 2, endpoint, deviceToken, publicKeyB64 })
}

describe('pairing a server that is already saved', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-same-server-'))
  })
  afterEach(async () => {
    await removeTempDirs([userDataPath])
  })

  it('refreshes the saved entry instead of saving the server twice under a new name', () => {
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio',
      pairingCode: pairingCode('ws://192.0.2.10:6768'),
      now: 100
    })

    const outcome = addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio over relay',
      pairingCode: pairingCode('wss://relay.example/runtime', 'second-token'),
      runtimeId: 'runtime-after-restart',
      now: 200
    })

    expect(outcome.updatedExisting).toBe(true)
    expect(outcome.environment).toMatchObject({
      id: first.id,
      name: 'Studio',
      createdAt: 100,
      updatedAt: 200,
      runtimeId: 'runtime-after-restart'
    })
    expect(outcome.environment.pairingRevision).toBeGreaterThan(first.pairingRevision ?? 0)
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual([first.id])
    expect(resolveEnvironmentPairingOffer(userDataPath, first.id)).toMatchObject({
      endpoint: 'wss://relay.example/runtime',
      deviceToken: 'second-token'
    })
  })

  it('matches the same key spelled unpadded or URL-safe', () => {
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio',
      pairingCode: pairingCode('ws://192.0.2.10:6768')
    })
    const urlSafeUnpadded = Buffer.alloc(32, 0xfb).toString('base64url')
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'Wide',
      pairingCode: pairingCode(
        'ws://192.0.2.12:6768',
        'token',
        Buffer.alloc(32, 0xfb).toString('base64')
      )
    })
    for (const spelling of [serverKey.replace(/=+$/, ''), urlSafeUnpadded]) {
      const target = spelling === urlSafeUnpadded ? 'Wide' : 'Studio'
      expect(
        addOrUpdateEnvironmentFromPairingCode(userDataPath, {
          name: `${target} again`,
          pairingCode: pairingCode('ws://192.0.2.20:6768', 'other-token', spelling)
        })
      ).toMatchObject({ updatedExisting: true, environment: { name: target } })
    }
    // The saved spelling stays, so the host-key fingerprint the renderer compares is unchanged.
    expect(resolveEnvironmentPairingOffer(userDataPath, first.id)).toMatchObject({
      publicKeyB64: serverKey,
      deviceToken: 'other-token'
    })
    expect(resolveEnvironmentPairingOffer(userDataPath, 'Wide').publicKeyB64).toBe(
      Buffer.alloc(32, 0xfb).toString('base64')
    )
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toContain(first.id)
    expect(listEnvironments(userDataPath)).toHaveLength(2)
  })
})
