import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import { __resetSecureFileHardenedPathsForTests } from '../../secure-file'
import { addEnvironmentFromPairingCode, listEnvironments } from './runtime-environment-store'
import { getEnvironmentStorePath } from './runtime-environment-store-records'

const chmodFailure = vi.hoisted(() => ({ active: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (chmodFailure.active) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      }
      return actual.chmodSync(...args)
    }
  }
})

let userDataPath: string
beforeEach(() => {
  userDataPath = fs.mkdtempSync(join(tmpdir(), 'orca-env-cache-integration-'))
  __resetSecureFileHardenedPathsForTests()
})
afterEach(() => {
  chmodFailure.active = false
  fs.rmSync(userDataPath, { recursive: true, force: true })
})

function addServer(name: string, seed: number): string {
  return addEnvironmentFromPairingCode(userDataPath, {
    name,
    pairingCode: encodePairingOffer({
      v: 2,
      publicKeyB64: Buffer.alloc(32, seed).toString('base64'),
      deviceToken: `token-${seed}`,
      endpoint: `wss://host-${seed}.example.com/runtime`
    }),
    now: 100 + seed
  }).id
}

describe('saved-server registry read reuse', () => {
  it('sees a registry rewritten by another writer between reads', () => {
    const first = addServer('Alpha', 1)
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual([first])
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual([first])

    const path = getEnvironmentStorePath(userDataPath)
    const store = JSON.parse(fs.readFileSync(path, 'utf8'))
    store.environments[0].name = 'Bravo'
    fs.writeFileSync(path, JSON.stringify(store), { mode: 0o600 })

    expect(listEnvironments(userDataPath).map((entry) => entry.name)).toEqual(['Bravo'])
  })

  it.skipIf(process.platform === 'win32')(
    'retries hardening on later reads after a transient chmod failure',
    () => {
      addServer('Alpha', 1)
      const path = getEnvironmentStorePath(userDataPath)
      fs.chmodSync(path, 0o644)
      __resetSecureFileHardenedPathsForTests()

      chmodFailure.active = true
      listEnvironments(userDataPath)
      listEnvironments(userDataPath)
      expect(fs.statSync(path).mode & 0o777).toBe(0o644)

      chmodFailure.active = false
      listEnvironments(userDataPath)
      expect(fs.statSync(path).mode & 0o777).toBe(0o600)
    }
  )
})
