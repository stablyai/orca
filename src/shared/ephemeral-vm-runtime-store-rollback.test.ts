import { mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from './testing/remove-temp-dirs.test-support'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getEphemeralVmRuntimeFeatureStorePath,
  MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES
} from './ephemeral-vm-runtime-feature-store'
import {
  EphemeralVmRuntimeStoreError,
  getEphemeralVmRuntimeStorePath,
  getEphemeralVmWriteAheadRuntimeStorePath,
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from './ephemeral-vm-runtime-store'
import {
  EphemeralVmRuntimeStoreSchema,
  RollbackEphemeralVmRuntimeStoreSchema,
  type EphemeralVmRuntimeRecord
} from './ephemeral-vm-runtimes'
import { findWorkspaceEphemeralVmRuntime } from './ephemeral-vm-workspace-runtime'

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

  afterEach(async () => {
    await removeTempDirs(tempDirs.splice(0))
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

  it('keeps result-less write-ahead records out of the file older builds read', () => {
    const userDataPath = makeUserDataPath()
    const ordinary = upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    const { recipeResult: _recipeResult, ...writeAheadFields } = provisionedRootRecord()
    const writeAhead = upsertEphemeralVmRuntime(userDataPath, {
      ...writeAheadFields,
      status: 'provisioning'
    })

    const persisted = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.parse(persisted).runtimes).toEqual([
      expect.objectContaining({ id: 'ordinary-runtime' })
    ])
    expect(
      JSON.parse(readFileSync(getEphemeralVmWriteAheadRuntimeStorePath(userDataPath), 'utf8'))
        .runtimes
    ).toEqual([expect.objectContaining({ id: 'provisioned-runtime', status: 'provisioning' })])
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([writeAhead, ordinary])

    const running = updateEphemeralVmRuntimeStatus(userDataPath, 'provisioned-runtime', {
      status: 'running',
      recipeResult: provisionedRootRecord().recipeResult,
      updatedAt: 2_000
    })

    const promoted = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.parse(promoted).runtimes).toEqual([
      expect.objectContaining({
        id: 'provisioned-runtime',
        recipe: expect.not.objectContaining({ checkoutMode: expect.anything() }),
        recipeResult: expect.objectContaining({ schemaVersion: 1 })
      }),
      expect.objectContaining({ id: 'ordinary-runtime' })
    ])
    expect(
      JSON.parse(readFileSync(getEphemeralVmWriteAheadRuntimeStorePath(userDataPath), 'utf8'))
        .runtimes
    ).toEqual([])
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([running, ordinary])
    expect(running).toEqual(provisionedRootRecord())
  })

  it('prefers the main record when a crash leaves a stale write-ahead copy', () => {
    const userDataPath = makeUserDataPath()
    const running = upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    const { recipeResult: _recipeResult, ...stale } = running
    writeFileSync(
      getEphemeralVmWriteAheadRuntimeStorePath(userDataPath),
      JSON.stringify({ version: 1, runtimes: [{ ...stale, status: 'provisioning' }] })
    )

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([running])
  })

  it('never overwrites a write-ahead file it cannot read', () => {
    const userDataPath = makeUserDataPath()
    upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    const sidecarPath = getEphemeralVmWriteAheadRuntimeStorePath(userDataPath)
    const unreadable = '{"version":2,"runtimes":[{"id":"from-a-newer-build"}]}'
    writeFileSync(sidecarPath, unreadable)

    // Tracked VMs keep working, and the unreadable records survive the write.
    updateEphemeralVmRuntimeStatus(userDataPath, 'ordinary-runtime', { status: 'suspended' })
    expect(readFileSync(sidecarPath, 'utf8')).toBe(unreadable)

    // A new record that could not be kept is refused before its create starts.
    const { recipeResult: _recipeResult, ...writeAhead } = runtimeRecord({ id: 'new-runtime' })
    expect(() =>
      upsertEphemeralVmRuntime(userDataPath, { ...writeAhead, status: 'provisioning' })
    ).toThrow()
    expect(readFileSync(sidecarPath, 'utf8')).toBe(unreadable)
  })

  it('never offers a result-less write-ahead record to workspace suspend or resume', () => {
    const userDataPath = makeUserDataPath()
    const { recipeResult: _recipeResult, ...writeAhead } = runtimeRecord({
      repoId: 'repo-1',
      workspaceId: 'workspace-1'
    })
    upsertEphemeralVmRuntime(userDataPath, { ...writeAhead, status: 'provisioning' })

    expect(findWorkspaceEphemeralVmRuntime(userDataPath, 'workspace-1')).toBeUndefined()

    updateEphemeralVmRuntimeStatus(userDataPath, 'ordinary-runtime', {
      status: 'running',
      recipeResult: runtimeRecord().recipeResult
    })
    expect(findWorkspaceEphemeralVmRuntime(userDataPath, 'workspace-1')).toMatchObject({
      id: 'ordinary-runtime',
      repoId: 'repo-1'
    })
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
