import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { EphemeralVmRuntimeRecord } from '../../../../../shared/ephemeral-vm-runtimes'
import {
  createEphemeralVmLifecycleSlice,
  projectEphemeralVmWorkspaceRuntimes,
  selectEphemeralVmWorkspaceFailure,
  selectEphemeralVmWorkspaceState
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

describe('ephemeral VM workspace projection', () => {
  it('shows an in-flight write-ahead create as provisioning', () => {
    const state = project([record('vm-1', 'provisioning')])
    expect(selectEphemeralVmWorkspaceState(state, 'ws-1')).toBe('provisioning')
  })

  it('shows an interrupted create as setup failed with its catalogued reason', () => {
    const state = project([
      record('vm-1', 'failed', {
        cleanupLastError: 'Orca stopped while this VM was being created.',
        cleanupLastErrorCode: 'provisionInterrupted'
      })
    ])
    expect(selectEphemeralVmWorkspaceState(state, 'ws-1')).toBe('provision_failed')
    expect(selectEphemeralVmWorkspaceFailure(state, 'ws-1')).toEqual({
      error: 'Orca stopped while this VM was being created.',
      errorCode: 'provisionInterrupted'
    })
  })

  it('prefers the provisioned VM over a newer result-less failed create', () => {
    const state = project([
      record('vm-new', 'failed', { cleanupLastError: 'boom' }),
      record('vm-old', 'suspended', { recipeResult: result })
    ])
    expect(state.ephemeralVmRuntimesByWorkspaceId['ws-1']?.id).toBe('vm-old')
    expect(selectEphemeralVmWorkspaceState(state, 'ws-1')).toBe('suspended')
  })

  it('carries the persisted resume failure code for the row tooltip', () => {
    const state = project([
      record('vm-1', 'resume_failed', {
        recipeResult: result,
        lifecycleLastError: 'Resume exited with code 3.',
        lifecycleLastErrorCode: 'resumeExited',
        lifecycleLastErrorParams: { exitCode: 3 }
      })
    ])
    expect(selectEphemeralVmWorkspaceFailure(state, 'ws-1')).toEqual({
      error: 'Resume exited with code 3.',
      errorCode: 'resumeExited',
      errorParams: { exitCode: 3 }
    })
  })

  it('ignores a stale lifecycle error once the VM is running again', () => {
    const state = project([
      record('vm-1', 'running', { recipeResult: result, lifecycleLastError: 'old' })
    ])
    expect(selectEphemeralVmWorkspaceState(state, 'ws-1')).toBeNull()
    expect(selectEphemeralVmWorkspaceFailure(state, 'ws-1')).toBeNull()
  })

  it('hides Suspend VM only when the recipe snapshot has no suspend step', () => {
    const recipe = { id: 'cloud', name: 'Cloud', create: 'create' }
    expect(
      project([record('vm-1', 'running', { recipeResult: result, recipe })])
        .ephemeralVmRuntimesByWorkspaceId['ws-1']?.canSuspend
    ).toBe(false)
    expect(
      project([
        record('vm-1', 'running', { recipeResult: result, recipe: { ...recipe, suspend: 's' } })
      ]).ephemeralVmRuntimesByWorkspaceId['ws-1']?.canSuspend
    ).toBe(true)
    expect(
      project([record('vm-1', 'running', { recipeResult: result })])
        .ephemeralVmRuntimesByWorkspaceId['ws-1']?.canSuspend
    ).toBe(true)
    // Main skips a VM whose repo it cannot resolve, so the menu must not offer it.
    expect(
      project([record('vm-1', 'running', { recipeResult: result, repoId: undefined })])
        .ephemeralVmRuntimesByWorkspaceId['ws-1']?.canSuspend
    ).toBe(false)
  })
})

describe('refreshEphemeralVmRuntimes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('settles a superseded refresh only once the newer read is in the store', async () => {
    const replies: ((records: EphemeralVmRuntimeRecord[]) => void)[] = []
    vi.stubGlobal('window', {
      api: {
        ephemeralVm: {
          listRuntimes: () =>
            new Promise<EphemeralVmRuntimeRecord[]>((resolve) => replies.push(resolve))
        }
      }
    })
    const store = create<AppState>()(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slice reads and writes only its own fields.
      (...a) => createEphemeralVmLifecycleSlice(...a) as AppState
    )
    let olderSettled = false
    const older = store
      .getState()
      .refreshEphemeralVmRuntimes()
      .then(() => {
        olderSettled = true
      })
    const newer = store.getState().refreshEphemeralVmRuntimes()

    replies[0]?.([record('vm-1', 'suspended', { recipeResult: result })])
    await Promise.resolve()
    await Promise.resolve()
    expect(olderSettled).toBe(false)

    replies[1]?.([record('vm-1', 'running', { recipeResult: result })])
    await Promise.all([older, newer])
    expect(store.getState().ephemeralVmRuntimesByWorkspaceId['ws-1']?.status).toBe('running')
  })
})
