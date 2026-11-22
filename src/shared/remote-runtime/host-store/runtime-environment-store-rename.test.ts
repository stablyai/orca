import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { afterEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  renameEnvironment
} from './runtime-environment-store-operations'
import {
  RuntimeEnvironmentStoreError,
  getEnvironmentStorePath
} from './runtime-environment-store-records'

function pairingCode(
  endpoint = 'ws://127.0.0.1:6768',
  pairedDeviceId?: string,
  keyFill = 1
): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(keyFill)).toString('base64'),
    ...(pairedDeviceId ? { pairedDeviceId } : {})
  })
}

describe('runtime environment store rename', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await removeTempDirs(tempDirs.splice(0))
  })

  it('renames a saved environment in place, keeping its id, pairing and endpoints', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode(),
      now: 100
    })

    const renamed = renameEnvironment(userDataPath, environment.id, {
      name: '  workstation  ',
      now: 200
    })

    expect(renamed).toMatchObject({
      id: environment.id,
      name: 'workstation',
      createdAt: 100,
      updatedAt: 200,
      endpoints: environment.endpoints,
      preferredEndpointId: environment.preferredEndpointId
    })
    expect(listEnvironments(userDataPath).map((entry) => entry.name)).toEqual(['workstation'])
  })

  it('refuses a rename that is empty or collides with another saved name', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Build',
      pairingCode: pairingCode(),
      now: 100
    })
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode('ws://192.0.2.10:6768', undefined, 2),
      now: 200
    })

    // A rejected rename must not rewrite the record: a bumped updatedAt alone would pass a name-only check.
    const storeBytes = readFileSync(getEnvironmentStorePath(userDataPath))
    // Typed-name normalization makes Build/build collide, like the add path.
    expect(() => renameEnvironment(userDataPath, first.id, { name: 'dev box' })).toThrow(
      /already exists/
    )
    expect(() => renameEnvironment(userDataPath, first.id, { name: '   ' })).toThrow(
      RuntimeEnvironmentStoreError
    )
    expect(readFileSync(getEnvironmentStorePath(userDataPath))).toEqual(storeBytes)
    // Renaming to the same spelling keeps the store write-free and is allowed.
    expect(renameEnvironment(userDataPath, first.id, { name: 'Build' }).name).toBe('Build')
    expect(listEnvironments(userDataPath).map((entry) => entry.name)).toEqual(['Build', 'dev box'])
  })
})
