import { describe, expect, it } from 'vitest'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot
} from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  isDisconnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from '@/runtime/runtime-host-connection-state'
import { getReachableRuntimeSessionMirrorTargets } from './runtime-session-mirror-targets'

const ENVIRONMENT_ID = 'env-a'

const environments = [{ id: ENVIRONMENT_ID, createdAt: 100, pairingRevision: 101 }]

function makeStatus(runtimeId: string): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3
  }
}

function makeSnapshot(
  patch: Partial<RuntimeHostStatusSnapshot> & Pick<RuntimeHostStatusSnapshot, 'verification'>
): RuntimeHostStatusSnapshot {
  return {
    environmentId: ENVIRONMENT_ID,
    pairingRevision: 101,
    sequence: 1,
    checkedAt: 1,
    status: makeStatus('rt-1'),
    transport: 'ready',
    ...patch
  }
}

/** The entry shape `applyRuntimeHostStatusSnapshot` writes for a given snapshot. */
function entryForSnapshot(snapshot: RuntimeHostStatusSnapshot) {
  return {
    ...runtimeEnvironmentStatusFromSnapshot(snapshot),
    connectionGeneration: 4
  }
}

function mirrorTargets(entry: ReturnType<typeof entryForSnapshot>) {
  return getReachableRuntimeSessionMirrorTargets({
    settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
    runtimeEnvironments: environments,
    runtimeStatusByEnvironmentId: new Map([[ENVIRONMENT_ID, entry]])
  })
}

describe('mirror targets and host connection state agree on one host', () => {
  // Null unverifiable probes on ready transport once cold-rebuilt mirrors while host flows still delivered; loss of contact never proves exit (ssh-execution-boundary.md).
  it('holds the mirror target when a ready transport returns an unverifiable probe', () => {
    const entry = entryForSnapshot(makeSnapshot({ verification: 'unavailable' }))

    expect(runtimeHostConnectionStateForEntry(entry)).toBe('runtime-unavailable')
    expect(mirrorTargets(entry)).toEqual([
      {
        environmentId: ENVIRONMENT_ID,
        runtimeId: 'rt-1',
        connectionGeneration: 4,
        pairingRevision: 101,
        hostContactEpoch: 0
      }
    ])
  })

  it('holds the mirror target while the transport is reconnecting', () => {
    // Dropped transport is unverifiable; it cannot authorize destroying a potentially live mirror.
    const entry = entryForSnapshot(
      makeSnapshot({ verification: 'unavailable', transport: 'disconnected' })
    )

    expect(runtimeHostConnectionStateForEntry(entry)).toBe('reconnecting')
    expect(mirrorTargets(entry)).toHaveLength(1)
  })

  it('keeps the same target across verified and unverifiable snapshots', () => {
    const verified = mirrorTargets(entryForSnapshot(makeSnapshot({ verification: 'verified' })))
    const unverifiable = mirrorTargets(
      entryForSnapshot(makeSnapshot({ verification: 'unavailable', sequence: 2 }))
    )

    expect(verified).toHaveLength(1)
    expect(unverifiable).toEqual(verified)
  })

  it.each([
    ['a retired host', makeSnapshot({ verification: 'verified', retired: true })],
    ['a blocked host', makeSnapshot({ verification: 'blocked' })]
  ])('drops the mirror target for %s', (_label, snapshot) => {
    const entry = entryForSnapshot(snapshot)

    expect(isDisconnectedRuntimeHostState(runtimeHostConnectionStateForEntry(entry))).toBe(true)
    expect(mirrorTargets(entry)).toEqual([])
  })

  it('drops the mirror target for a host that has never verified', () => {
    // Unverifiable, but there is no runtime identity to mirror yet.
    const entry = entryForSnapshot(makeSnapshot({ verification: 'checking', status: null }))

    expect(runtimeHostConnectionStateForEntry(entry)).toBe('checking')
    expect(mirrorTargets(entry)).toEqual([])
  })

  it('drops the mirror target when the control channel closed', () => {
    const closed: NonNullable<RuntimeStatus['remoteControl']> = {
      state: 'closed',
      pendingRequestCount: 0,
      subscriptionCount: 0,
      reconnectAttempt: 0,
      lastConnectedAt: null,
      lastClose: null,
      lastError: null
    }
    const entry = {
      ...entryForSnapshot(makeSnapshot({ verification: 'verified' })),
      remoteControl: closed
    }

    expect(runtimeHostConnectionStateForEntry(entry)).toBe('disconnected')
    expect(mirrorTargets(entry)).toEqual([])
  })
})
