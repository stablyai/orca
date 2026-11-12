import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from './testing/remove-temp-dirs.test-support'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getEphemeralVmWriteAheadRuntimeStorePath,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from './ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'

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
})
