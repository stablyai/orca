import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import type * as BoundedReader from '../../file-content/node-bounded-file-reader'
import { __resetSecureFileHardenedPathsForTests } from '../../secure-storage/secure-file'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  resolveEnvironment
} from './runtime-environment-store'
import { getEnvironmentStorePath } from './runtime-environment-store-records'

type ReadHook = ((path: string) => void) | undefined
const hooks = vi.hoisted((): { failChmod: boolean; beforeRead: ReadHook; afterRead: ReadHook } => ({
  failChmod: false,
  beforeRead: undefined,
  afterRead: undefined
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (hooks.failChmod) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      }
      return actual.chmodSync(...args)
    }
  }
})
vi.mock('../../file-content/node-bounded-file-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof BoundedReader>()
  return {
    ...actual,
    readNodeFileSyncWithinLimit: (
      ...args: Parameters<typeof actual.readNodeFileSyncWithinLimit>
    ) => {
      hooks.beforeRead?.(args[0])
      try {
        return actual.readNodeFileSyncWithinLimit(...args)
      } finally {
        hooks.afterRead?.(args[0])
      }
    }
  }
})

let root: string
let userDataPath: string
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'orca-env-cache-integration-'))
  userDataPath = join(root, 'userData')
  fs.mkdirSync(userDataPath, { mode: 0o700 })
  __resetSecureFileHardenedPathsForTests()
})
afterEach(async () => {
  vi.useRealTimers()
  hooks.failChmod = false
  hooks.beforeRead = undefined
  hooks.afterRead = undefined
  await removeTempDirs([root])
})

function addServer(profile: string, name: string, seed: number): string {
  return addEnvironmentFromPairingCode(profile, {
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

const names = (): string[] => listEnvironments(userDataPath).map((entry) => entry.name)

function countStoreReads(): () => number {
  const storePath = getEnvironmentStorePath(userDataPath)
  let reads = 0
  hooks.beforeRead = (path) => {
    if (path === storePath) {
      reads++
    }
  }
  return () => reads
}

function settleRegistryTimestamps(): void {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  vi.setSystemTime(Date.now() + 10_000)
}

describe('saved-server registry read reuse', () => {
  it('sees a registry rewritten by another writer between reads', () => {
    addServer(userDataPath, 'Alpha', 1)
    expect(names()).toEqual(['Alpha'])
    expect(names()).toEqual(['Alpha'])

    const path = getEnvironmentStorePath(userDataPath)
    const store = JSON.parse(fs.readFileSync(path, 'utf8'))
    store.environments[0].name = 'Bravo'
    fs.writeFileSync(path, JSON.stringify(store), { mode: 0o600 })

    expect(names()).toEqual(['Bravo'])
  })

  it('does not keep a value read from a directory swapped in and back out mid-read', () => {
    addServer(userDataPath, 'Alpha', 1)
    const other = join(root, 'other')
    fs.mkdirSync(other, { mode: 0o700 })
    addServer(other, 'Bravo', 2)
    const parked = join(root, 'parked')
    const storePath = getEnvironmentStorePath(userDataPath)
    let storeReads = 0
    hooks.beforeRead = (path) => {
      // The first read checks for a reusable value; the second is the one a value is built from.
      if (path === storePath && ++storeReads === 2) {
        fs.renameSync(userDataPath, parked)
        fs.renameSync(other, userDataPath)
      }
    }
    hooks.afterRead = (path) => {
      if (path === storePath && fs.existsSync(parked)) {
        fs.renameSync(userDataPath, other)
        fs.renameSync(parked, userDataPath)
      }
    }
    // The racing read may report what it saw, but must not be reused once the original is back.
    names()
    hooks.beforeRead = undefined
    hooks.afterRead = undefined
    expect(names()).toEqual(['Alpha'])
    expect(names()).toEqual(['Alpha'])
  })

  it.skipIf(process.platform === 'win32').each([
    ['readable by others', 0o644],
    ['owner read-only', 0o400],
    ['setuid', 0o4600]
  ])('retries hardening a registry left %s by a transient chmod failure', (_label, mode) => {
    addServer(userDataPath, 'Alpha', 1)
    const path = getEnvironmentStorePath(userDataPath)
    fs.chmodSync(path, mode)
    __resetSecureFileHardenedPathsForTests()

    hooks.failChmod = true
    names()
    names()
    expect(fs.statSync(path).mode & 0o7777).toBe(mode)

    hooks.failChmod = false
    names()
    expect(fs.statSync(path).mode & 0o7777).toBe(0o600)
  })
})

describe.skipIf(process.platform === 'win32')('saved-server registry reuse from metadata', () => {
  it('resolves a settled registry from file metadata alone', () => {
    const id = addServer(userDataPath, 'Alpha', 1)
    settleRegistryTimestamps()
    resolveEnvironment(userDataPath, id)
    const storeReads = countStoreReads()

    for (let lookup = 0; lookup < 50; lookup++) {
      expect(resolveEnvironment(userDataPath, id).name).toBe('Alpha')
    }
    expect(names()).toEqual(['Alpha'])

    expect(storeReads()).toBe(0)
  })

  it('sees a settled registry replaced by another writer', () => {
    const id = addServer(userDataPath, 'Alpha', 1)
    settleRegistryTimestamps()
    expect(resolveEnvironment(userDataPath, id).name).toBe('Alpha')

    const path = getEnvironmentStorePath(userDataPath)
    const store = JSON.parse(fs.readFileSync(path, 'utf8'))
    store.environments[0].name = 'Bravo'
    fs.writeFileSync(`${path}.tmp`, JSON.stringify(store), { mode: 0o600 })
    fs.renameSync(`${path}.tmp`, path)

    expect(resolveEnvironment(userDataPath, id).name).toBe('Bravo')
    expect(names()).toEqual(['Bravo'])
  })

  it('compares bytes again while the registry changed too recently to trust its timestamps', () => {
    const id = addServer(userDataPath, 'Alpha', 1)
    resolveEnvironment(userDataPath, id)
    const storeReads = countStoreReads()

    resolveEnvironment(userDataPath, id)

    expect(storeReads()).toBe(1)
  })

  it('compares bytes again after the wall clock steps back', () => {
    const id = addServer(userDataPath, 'Alpha', 1)
    settleRegistryTimestamps()
    resolveEnvironment(userDataPath, id)
    const storeReads = countStoreReads()

    vi.setSystemTime(Date.now() - 5_000)
    resolveEnvironment(userDataPath, id)

    expect(storeReads()).toBe(1)
  })

  it('keeps a caller mutating its result out of later lookups', () => {
    const id = addServer(userDataPath, 'Alpha', 1)
    settleRegistryTimestamps()
    resolveEnvironment(userDataPath, id).name = 'Mutated'
    listEnvironments(userDataPath)[0]!.name = 'Mutated'

    expect(resolveEnvironment(userDataPath, id).name).toBe('Alpha')
    expect(names()).toEqual(['Alpha'])
  })
})
