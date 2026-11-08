import { describe, expect, it } from 'vitest'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import {
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
})
