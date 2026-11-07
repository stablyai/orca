import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import { addEnvironmentFromPairingCode } from './runtime-environment-store'
import { readEnvironmentStore } from './runtime-environment-store-file'
import { getEnvironmentStorePath } from './runtime-environment-store-records'
import { getRuntimeEnvironmentSidecarPath } from './runtime-environment-sidecar'

const tempDirs: string[] = []

function userDataWithServer(name: string): string {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-cache-'))
  tempDirs.push(userDataPath)
  addEnvironmentFromPairingCode(userDataPath, {
    name,
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: 'ws://192.0.2.10:6768',
      deviceToken: 'device-token',
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
    })
  })
  return userDataPath
}

describe('readEnvironmentStore cache', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sees a rename another process saved after a cached read', () => {
    const userDataPath = userDataWithServer('before')
    expect(readEnvironmentStore(userDataPath).environments.map(({ name }) => name)).toEqual([
      'before'
    ])

    // Another Orca process replaces the file atomically, as every registry writer does.
    const path = getEnvironmentStorePath(userDataPath)
    const replacement = readFileSync(path, 'utf8').replace('"before"', '"after!"')
    writeFileSync(`${path}.tmp`, replacement)
    renameSync(`${path}.tmp`, path)

    expect(readEnvironmentStore(userDataPath).environments.map(({ name }) => name)).toEqual([
      'after!'
    ])
  })

  it('does not let a caller that edits a cached result change the next read', () => {
    const userDataPath = userDataWithServer('original')
    readEnvironmentStore(userDataPath)
    const cached = readEnvironmentStore(userDataPath)
    cached.environments[0].name = 'edited in memory'
    cached.environments[0].endpoints.length = 0

    const next = readEnvironmentStore(userDataPath)
    expect(next.environments[0].name).toBe('original')
    expect(next.environments[0].endpoints).not.toHaveLength(0)
  })

  it('rereads after the link file changes, and keeps no failed read', () => {
    const userDataPath = userDataWithServer('linked')
    readEnvironmentStore(userDataPath)
    const sidecar = getRuntimeEnvironmentSidecarPath(userDataPath)

    writeFileSync(sidecar, '{"version":1,"entries":')
    expect(() => readEnvironmentStore(userDataPath)).toThrow()
    expect(() => readEnvironmentStore(userDataPath)).toThrow()

    rmSync(sidecar)
    expect(readEnvironmentStore(userDataPath).environments.map(({ name }) => name)).toEqual([
      'linked'
    ])
  })

  it.skipIf(process.platform === 'win32')(
    'still re-hardens the registry folder when a read is served from the cache',
    () => {
      const userDataPath = userDataWithServer('hardened')
      readEnvironmentStore(userDataPath)
      chmodSync(userDataPath, 0o755)

      readEnvironmentStore(userDataPath)

      expect(statSync(userDataPath).mode & 0o777).toBe(0o700)
    }
  )
})
