import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { getReachableRuntimeSessionMirrorTargets } from './runtime-session-mirror-targets'

function makeStatus(runtimeId: string): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}

const environments = [
  {
    id: 'online-env',
    createdAt: 100,
    pairingRevision: 101
  },
  {
    id: 'offline-env',
    createdAt: 200
  }
]

describe('getReachableRuntimeSessionMirrorTargets', () => {
  it('subscribes only after a runtime health probe succeeds', () => {
    expect(
      getReachableRuntimeSessionMirrorTargets({
        settings: { activeRuntimeEnvironmentId: 'online-env' },
        repos: [{ id: 'offline-repo', connectionId: null, executionHostId: 'runtime:offline-env' }],
        runtimeEnvironments: environments,
        runtimeStatusByEnvironmentId: new Map([
          [
            'online-env',
            {
              status: makeStatus('runtime-online'),
              connectionGeneration: 3
            }
          ],
          ['offline-env', { status: null, connectionGeneration: 7 }]
        ])
      })
    ).toEqual([
      {
        environmentId: 'online-env',
        runtimeId: 'runtime-online',
        connectionGeneration: 3,
        pairingRevision: 101,
        hostContactEpoch: 0
      }
    ])
  })

  it('waits for both the saved environment and its first successful status', () => {
    expect(
      getReachableRuntimeSessionMirrorTargets({
        settings: { activeRuntimeEnvironmentId: 'online-env' },
        runtimeEnvironments: environments,
        runtimeStatusByEnvironmentId: new Map()
      })
    ).toEqual([])

    expect(
      getReachableRuntimeSessionMirrorTargets({
        settings: { activeRuntimeEnvironmentId: 'missing-env' },
        runtimeEnvironments: environments,
        runtimeStatusByEnvironmentId: new Map([
          ['missing-env', { status: makeStatus('runtime-missing') }]
        ])
      })
    ).toEqual([])
  })

  it('uses creation time for environments paired before pairing revisions existed', () => {
    expect(
      getReachableRuntimeSessionMirrorTargets({
        settings: { activeRuntimeEnvironmentId: 'offline-env' },
        runtimeEnvironments: environments,
        runtimeStatusByEnvironmentId: new Map([
          ['offline-env', { status: makeStatus('runtime-recovered') }]
        ])
      })
    ).toEqual([
      {
        environmentId: 'offline-env',
        runtimeId: 'runtime-recovered',
        connectionGeneration: 0,
        pairingRevision: 200,
        hostContactEpoch: 0
      }
    ])
  })
})
