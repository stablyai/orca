import { describe, expect, it } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  getReachableRuntimeEnvironmentIds,
  getRuntimeClientEventEnvironmentIds
} from '@/hooks/ipc-events/runtime-environment-subscription-selection'
import type { RuntimeEnvironmentStoreSyncState } from '@/hooks/ipc-events/runtime-environment-subscription-selection'
import {
  selectRuntimeAwareSshError,
  selectRuntimeAwareSshStatus
} from '@/store/slices/runtime-environment-ssh-selectors'

const ENVIRONMENT_ID = 'environment-a'
const VERIFIED_STATUS = { runtimeId: 'runtime-a' } as RuntimeStatus

function snapshot(overrides: Partial<RuntimeHostStatusSnapshot> = {}): RuntimeHostStatusSnapshot {
  return {
    environmentId: ENVIRONMENT_ID,
    pairingRevision: 1,
    sequence: 2,
    checkedAt: 2,
    status: VERIFIED_STATUS,
    verification: 'verified',
    transport: 'ready',
    ...overrides
  }
}

/** The defect shape: the host answered once, its transport is still up, the last probe did not answer. */
function unverifiableWhileReady(): {
  status: null
  checkedAt: number
  snapshot: RuntimeHostStatusSnapshot
} {
  return { status: null, checkedAt: 2, snapshot: snapshot({ verification: 'unavailable' }) }
}

function transportDown(): { status: null; checkedAt: number; snapshot: RuntimeHostStatusSnapshot } {
  return {
    status: null,
    checkedAt: 2,
    snapshot: snapshot({ verification: 'unavailable', transport: 'disconnected' })
  }
}

function syncState(
  entry: {
    status: RuntimeStatus | null
    checkedAt: number
    snapshot?: RuntimeHostStatusSnapshot
  } | null
): RuntimeEnvironmentStoreSyncState {
  return {
    runtimeEnvironments: [{ id: ENVIRONMENT_ID, createdAt: 1 }],
    runtimeStatusByEnvironmentId: entry ? new Map([[ENVIRONMENT_ID, entry]]) : new Map(),
    settings: { activeRuntimeEnvironmentId: null },
    sshStateByEnvironment: new Map()
  } as unknown as RuntimeEnvironmentStoreSyncState
}

describe('runtime client-event subscription selection', () => {
  it('keeps a host whose transport is ready but whose last probe went unverifiable', () => {
    expect(getRuntimeClientEventEnvironmentIds(syncState(unverifiableWhileReady()))).toEqual([
      ENVIRONMENT_ID
    ])
  })

  it('keeps that host in the reachable set, so no spurious disconnect edge fires', () => {
    expect(getReachableRuntimeEnvironmentIds(syncState(unverifiableWhileReady()))).toEqual([
      ENVIRONMENT_ID
    ])
  })

  it('still drops a host whose transport went down', () => {
    expect(getRuntimeClientEventEnvironmentIds(syncState(transportDown()))).toEqual([])
    expect(getReachableRuntimeEnvironmentIds(syncState(transportDown()))).toEqual([])
  })

  it('still drops a retired host and one that never answered', () => {
    const retired = { status: null, checkedAt: 2, snapshot: snapshot({ retired: true }) }
    expect(getRuntimeClientEventEnvironmentIds(syncState(retired))).toEqual([])
    expect(
      getRuntimeClientEventEnvironmentIds(
        syncState({
          status: null,
          checkedAt: 0,
          snapshot: snapshot({ status: null, verification: 'checking' })
        })
      )
    ).toEqual([])
    expect(getRuntimeClientEventEnvironmentIds(syncState(null))).toEqual([])
  })

  it('keeps a verified host', () => {
    expect(
      getRuntimeClientEventEnvironmentIds(
        syncState({ status: VERIFIED_STATUS, checkedAt: 2, snapshot: snapshot() })
      )
    ).toEqual([ENVIRONMENT_ID])
  })
})

describe('runtime-aware SSH selectors', () => {
  function sshState(entry: {
    status: RuntimeStatus | null
    checkedAt: number
    snapshot?: RuntimeHostStatusSnapshot
  }) {
    return {
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      removedSshTargetLabels: new Map(),
      sshTargetsHydrated: true,
      sshStateByEnvironment: new Map([
        [
          ENVIRONMENT_ID,
          {
            targetsHydrated: true,
            connectionStates: new Map([['target-a', { status: 'connected', error: 'boom' }]]),
            targetLabels: new Map([['target-a', 'Target A']]),
            removedTargetLabels: new Map()
          }
        ]
      ]),
      runtimeStatusByEnvironmentId: new Map([[ENVIRONMENT_ID, entry]])
    } as unknown as Parameters<typeof selectRuntimeAwareSshStatus>[0]
  }

  it('keeps reporting a mirrored SSH target while the host probe is unverifiable', () => {
    const state = sshState(unverifiableWhileReady())
    expect(selectRuntimeAwareSshStatus(state, ENVIRONMENT_ID, 'target-a')).toBe('connected')
    expect(selectRuntimeAwareSshError(state, ENVIRONMENT_ID, 'target-a')).toBe('boom')
  })

  it('still withholds SSH state once the transport is down', () => {
    const state = sshState(transportDown())
    expect(selectRuntimeAwareSshStatus(state, ENVIRONMENT_ID, 'target-a')).toBeNull()
  })
})
