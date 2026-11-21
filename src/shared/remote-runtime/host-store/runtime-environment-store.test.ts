import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  renameEnvironment
} from './runtime-environment-store-operations'
import {
  RuntimeEnvironmentStoreError,
  getEnvironmentStorePath,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES
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

describe('runtime environment store', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await removeTempDirs(tempDirs.splice(0))
  })

  it('backs up a NUL-filled store when a server is saved over it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-nul-'))
    tempDirs.push(userDataPath)
    writeFileSync(getEnvironmentStorePath(userDataPath), Buffer.alloc(640))

    // Plain reads stay fail-closed: an empty answer would read as "every server was removed".
    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    // A save that fails must leave the blank file, not an empty registry, behind.
    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'x'.repeat(MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES),
        pairingCode: pairingCode()
      })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    const added = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    expect(listEnvironments(userDataPath)).toEqual([added])
    const backups = readdirSync(userDataPath).filter((name) =>
      name.startsWith('orca-environments.json.corrupt-')
    )
    // The rejected save above left no copy; only the save that replaced the file did.
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(userDataPath, backups[0]))).toEqual(Buffer.alloc(640))
  })

  it.each([
    ['a newer format', '{"version":2,"environments":[]}'],
    ['truncated JSON that may still hold servers', '{"version":1,"environments":[{"id":"a"']
  ])('does not overwrite %s when a server is saved', (_label, contents) => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-invalid-'))
    tempDirs.push(userDataPath)
    writeFileSync(getEnvironmentStorePath(userDataPath), contents)

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode: pairingCode() })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(readdirSync(userDataPath)).toEqual(['orca-environments.json'])
    expect(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).toBe(contents)
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
