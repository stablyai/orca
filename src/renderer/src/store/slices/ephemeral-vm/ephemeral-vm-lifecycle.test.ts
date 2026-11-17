import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { EphemeralVmRuntimeRecord } from '../../../../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import {
  createEphemeralVmLifecycleSlice,
  projectEphemeralVmWorkspaceRuntimes
} from './ephemeral-vm-lifecycle'

const result: EphemeralVmRuntimeRecord['recipeResult'] = {
  schemaVersion: 1,
  pairingCode: 'orca://pair/test',
  projectRoot: '/workspace/repo'
}

function record(
  id: string,
  status: EphemeralVmRuntimeRecord['status'],
  extra: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return {
    id,
    recipeId: 'cloud',
    workspaceId: 'ws-1',
    repoId: 'repo-1',
    status,
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    ...extra
  }
}

function project(records: EphemeralVmRuntimeRecord[]) {
  const ephemeralVmRuntimesByWorkspaceId = projectEphemeralVmWorkspaceRuntimes(records)
  return { ephemeralVmRuntimesByWorkspaceId, wakingEphemeralVmWorkspaceIds: {} }
}

describe('Orca Cloud environment builds', () => {
  it('exposes the environment build an Orca Cloud workspace booted from', () => {
    const fromBuild: EphemeralVmRuntimeRecord['recipeResult'] = {
      ...result,
      userData: {
        environmentDriver: {
          driverId: 'orca-cloud',
          environmentId: 'sbx_1',
          driverState: { sandboxId: 'sbx_1', environmentBuildId: 'bld_0123456789' }
        }
      }
    }
    const built = project([record('vm', 'running', { recipeResult: fromBuild })])
    expect(built.ephemeralVmRuntimesByWorkspaceId['ws-1']?.environmentBuildId).toBe(
      'bld_0123456789'
    )
    const plain = project([record('vm', 'running', { recipeResult: result })])
    expect(plain.ephemeralVmRuntimesByWorkspaceId['ws-1']?.environmentBuildId).toBeUndefined()
  })
})

describe('refreshEphemeralVmRuntimes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('publishes a refresh that only moves updatedAt, projectId or the environment build', async () => {
    let records = [record('vm', 'running', { recipeResult: result })]
    vi.stubGlobal('window', { api: { ephemeralVm: { listRuntimes: async () => records } } })
    const store = create<AppState>()(
      (...args) => createEphemeralVmLifecycleSlice(...args) as unknown as AppState
    )
    const runtime = () => store.getState().ephemeralVmRuntimesByWorkspaceId['ws-1']
    await store.getState().refreshEphemeralVmRuntimes()

    records = [record('vm', 'running', { recipeResult: result, updatedAt: 2 })]
    await store.getState().refreshEphemeralVmRuntimes()
    expect(runtime()?.updatedAt).toBe(2)

    records = [
      record('vm', 'running', { recipeResult: result, updatedAt: 2, projectId: 'project-1' })
    ]
    await store.getState().refreshEphemeralVmRuntimes()
    expect(runtime()?.projectId).toBe('project-1')

    const unchanged = runtime()
    await store.getState().refreshEphemeralVmRuntimes()
    expect(runtime()).toBe(unchanged)
  })
})
