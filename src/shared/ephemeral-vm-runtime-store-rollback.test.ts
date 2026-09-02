import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getEphemeralVmRuntimeFeatureStorePath,
  MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES
} from './ephemeral-vm-runtime-feature-store'
import {
  EphemeralVmRuntimeStoreError,
  getEphemeralVmRuntimeStorePath,
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from './ephemeral-vm-runtime-store'
import {
  EphemeralVmRuntimeStoreSchema,
  RollbackEphemeralVmRuntimeStoreSchema,
  type EphemeralVmRuntimeRecord
} from './ephemeral-vm-runtimes'

function runtimeRecord(
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return {
    id: 'ordinary-runtime',
    recipeId: 'ordinary-recipe',
    recipe: {
      id: 'ordinary-recipe',
      name: 'Ordinary VM',
      create: './create.sh',
      destroy: './destroy.sh'
    },
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/ordinary',
        target: {
          label: 'Ordinary VM',
          host: 'ordinary.example.com',
          port: 22,
          username: 'developer'
        }
      },
      userData: { resourceId: 'ordinary-resource' }
    },
    ...overrides
  }
}

function provisionedRootRecord(): EphemeralVmRuntimeRecord {
  return runtimeRecord({
    id: 'provisioned-runtime',
    recipeId: 'provisioned-recipe',
    recipe: {
      id: 'provisioned-recipe',
      name: 'Provisioned VM',
      create: './create.sh',
      destroy: './destroy.sh',
      checkoutMode: 'provisioned-root'
    },
    createdAt: 2_000,
    updatedAt: 2_000,
    recipeResult: {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/provisioned',
        target: {
          label: 'Provisioned VM',
          host: 'provisioned.example.com',
          port: 22,
          username: 'developer'
        }
      },
      userData: { resourceId: 'provisioned-resource' }
    }
  })
}

describe('ephemeral VM runtime store rollback projection', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeUserDataPath(): string {
    const path = mkdtempSync(join(tmpdir(), 'orca-vm-rollback-store-'))
    tempDirs.push(path)
    return path
  }

  it('keeps a mixed store readable by the rollback schema and restores new fields', () => {
    const userDataPath = makeUserDataPath()
    const ordinary = upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    const provisioned = upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())

    const persisted = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.parse(persisted).runtimes).toHaveLength(2)
    expect(persisted.runtimes[0].recipe).not.toHaveProperty('checkoutMode')
    expect(persisted.runtimes[0].recipeResult).toMatchObject({ schemaVersion: 1 })
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([provisioned, ordinary])
  })

  it('keeps ordinary v1 bytes and sidecar behavior unchanged', () => {
    const userDataPath = makeUserDataPath()
    const runtime = runtimeRecord()
    const expected = JSON.stringify(
      EphemeralVmRuntimeStoreSchema.parse({ version: 1, runtimes: [runtime] })
    )

    upsertEphemeralVmRuntime(userDataPath, runtime)

    expect(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8')).toBe(expected)
    expect(existsSync(getEphemeralVmRuntimeFeatureStorePath(userDataPath))).toBe(false)
  })

  it('projects an explicit ordinary checkout mode without changing its current meaning', () => {
    const userDataPath = makeUserDataPath()
    const runtime = runtimeRecord({
      recipe: { ...runtimeRecord().recipe!, checkoutMode: 'orca-worktree' }
    })

    upsertEphemeralVmRuntime(userDataPath, runtime)

    const persisted = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.safeParse(persisted).success).toBe(true)
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([runtime])
  })

  it('does not rewrite unchanged features when runtime order differs from feature order', () => {
    const userDataPath = makeUserDataPath()
    const older = {
      ...provisionedRootRecord(),
      id: 'a-runtime',
      recipeId: 'a-recipe',
      createdAt: 1_000
    }
    const newer = {
      ...provisionedRootRecord(),
      id: 'z-runtime',
      recipeId: 'z-recipe',
      createdAt: 2_000
    }
    upsertEphemeralVmRuntime(userDataPath, older)
    upsertEphemeralVmRuntime(userDataPath, newer)
    const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
    const oldTimestamp = new Date('2020-01-01T00:00:00.000Z')
    utimesSync(featurePath, oldTimestamp, oldTimestamp)
    const beforeBytes = readFileSync(featurePath, 'utf8')
    const beforeMtime = statSync(featurePath).mtimeMs

    updateEphemeralVmRuntimeStatus(userDataPath, newer.id, { status: 'suspended' })

    expect(readFileSync(featurePath, 'utf8')).toBe(beforeBytes)
    expect(statSync(featurePath).mtimeMs).toBe(beforeMtime)
  })

  it('migrates current-main poisoned bytes when they are first read', () => {
    const userDataPath = makeUserDataPath()
    const poisoned = {
      version: 1 as const,
      runtimes: [provisionedRootRecord(), runtimeRecord()]
    }
    writeFileSync(
      getEphemeralVmRuntimeStorePath(userDataPath),
      JSON.stringify(EphemeralVmRuntimeStoreSchema.parse(poisoned))
    )

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual(poisoned.runtimes)
    expect(
      RollbackEphemeralVmRuntimeStoreSchema.safeParse(
        JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
      ).success
    ).toBe(true)
  })

  it('carries rollback lifecycle mutations through re-upgrade', () => {
    const userDataPath = makeUserDataPath()
    upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())
    const path = getEphemeralVmRuntimeStorePath(userDataPath)
    const rollback = RollbackEphemeralVmRuntimeStoreSchema.parse(
      JSON.parse(readFileSync(path, 'utf8'))
    )
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        runtimes: rollback.runtimes.map((runtime) =>
          runtime.id === 'provisioned-runtime'
            ? { ...runtime, status: 'cleaned', cleanupStatus: 'succeeded', updatedAt: 3_000 }
            : { ...runtime, status: 'suspended', updatedAt: 3_000 }
        )
      })
    )

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([
      expect.objectContaining({
        id: 'provisioned-runtime',
        status: 'cleaned',
        cleanupStatus: 'succeeded',
        recipe: expect.objectContaining({ checkoutMode: 'provisioned-root' }),
        recipeResult: expect.objectContaining({
          schemaVersion: 2,
          checkoutMode: 'provisioned-root'
        })
      }),
      expect.objectContaining({ id: 'ordinary-runtime', status: 'suspended' })
    ])
  })

  it('preserves unknown feature records while valid siblings remain usable', () => {
    const userDataPath = makeUserDataPath()
    upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())
    const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
    const featureStore = JSON.parse(readFileSync(featurePath, 'utf8'))
    const futureRecord = { kind: 'future-runtime-feature', payload: { version: 3 } }
    writeFileSync(
      featurePath,
      JSON.stringify({ ...featureStore, records: [...featureStore.records, futureRecord] })
    )

    expect(listEphemeralVmRuntimes(userDataPath)).toHaveLength(2)
    updateEphemeralVmRuntimeStatus(userDataPath, 'ordinary-runtime', { status: 'suspended' })
    expect(JSON.parse(readFileSync(featurePath, 'utf8')).records).toContainEqual(futureRecord)
  })

  it.each([
    ['malformed', '{ nope'],
    ['future-version', JSON.stringify({ version: 2, records: [] })]
  ])(
    'preserves an unreadable %s feature sidecar while keeping v1 records accessible',
    (_, bytes) => {
      const userDataPath = makeUserDataPath()
      upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
      upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())
      const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
      writeFileSync(featurePath, bytes)

      expect(listEphemeralVmRuntimes(userDataPath).map((runtime) => runtime.id)).toEqual([
        'provisioned-runtime',
        'ordinary-runtime'
      ])
      updateEphemeralVmRuntimeStatus(userDataPath, 'ordinary-runtime', { status: 'suspended' })
      expect(readFileSync(featurePath, 'utf8')).toBe(bytes)
    }
  )

  it('publishes lifecycle authority before an unreadable feature companion', () => {
    const userDataPath = makeUserDataPath()
    upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
    writeFileSync(featurePath, '{}')
    truncateSync(featurePath, MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES + 1)
    expect(() => upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())).toThrow(
      EphemeralVmRuntimeStoreError
    )
    const persisted = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.parse(persisted).runtimes).toHaveLength(2)
    expect(readFileSync(featurePath, 'utf8')).toHaveLength(
      MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES + 1
    )
    expect(listEphemeralVmRuntimes(userDataPath).map((runtime) => runtime.id)).toEqual([
      'provisioned-runtime',
      'ordinary-runtime'
    ])
  })
})
