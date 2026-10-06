import { describe, expect, it } from 'vitest'
import type { LocalCapacitySignal } from '../../../shared/local-capacity-signal-types'
import type { RuntimeStatus } from '../../../shared/runtime-session-contracts'
import {
  suggestDefaultRunTarget,
  type DefaultRunTargetSuggestionInput,
  type RemoteServerRunTargetCandidate,
  type SshRunTargetCandidate
} from './default-run-target-suggestion'

const NO_FLAGS: LocalCapacitySignal = {
  onBattery: false,
  lowMemory: false,
  lowCpu: false,
  reasons: []
}

const ON_BATTERY_AND_LOW_MEMORY: LocalCapacitySignal = {
  onBattery: true,
  lowMemory: true,
  lowCpu: false,
  reasons: ['on battery', 'low memory']
}

// Why: the live arm's status is never read by the suggestion; only the verdict is. Minimal but real.
const LIVE_RUNTIME_STATUS: RuntimeStatus = {
  runtimeId: 'runtime-1',
  rendererGraphEpoch: 0,
  graphStatus: 'ready',
  authoritativeWindowId: null,
  liveTabCount: 0,
  liveLeafCount: 0
}

function liveRemoteServer(hostId: string): RemoteServerRunTargetCandidate {
  return { hostId: `runtime:${hostId}`, contact: { verdict: 'live', status: LIVE_RUNTIME_STATUS } }
}

function unverifiableRemoteServer(hostId: string): RemoteServerRunTargetCandidate {
  return {
    hostId: `runtime:${hostId}`,
    contact: { verdict: 'unverifiable', reason: 'transport-down', lastAnswer: null }
  }
}

function refusedRemoteServer(hostId: string): RemoteServerRunTargetCandidate {
  return { hostId: `runtime:${hostId}`, contact: { verdict: 'refused', lastAnswer: null } }
}

function retiredRemoteServer(hostId: string): RemoteServerRunTargetCandidate {
  return { hostId: `runtime:${hostId}`, contact: { verdict: 'retired', lastAnswer: null } }
}

function sshTarget(hostId: string, status: SshRunTargetCandidate['status']): SshRunTargetCandidate {
  return { hostId: `ssh:${hostId}`, status }
}

function suggest(
  overrides: Partial<DefaultRunTargetSuggestionInput> = {}
): ReturnType<typeof suggestDefaultRunTarget> {
  return suggestDefaultRunTarget({
    signal: ON_BATTERY_AND_LOW_MEMORY,
    preferRunnerWhenLocalWeak: true,
    remoteServerCandidates: [],
    sshCandidates: [],
    ...overrides
  })
}

describe('suggestDefaultRunTarget', () => {
  it('stays silent while the setting is off', () => {
    expect(
      suggest({
        preferRunnerWhenLocalWeak: false,
        remoteServerCandidates: [liveRemoteServer('server-1')],
        sshCandidates: [sshTarget('dev-box', 'connected')]
      })
    ).toBeNull()
  })

  it('stays silent when no capacity flag is true', () => {
    expect(
      suggest({
        signal: NO_FLAGS,
        remoteServerCandidates: [liveRemoteServer('server-1')],
        sshCandidates: [sshTarget('dev-box', 'connected')]
      })
    ).toBeNull()
  })

  it('stays silent when the signal is unknown', () => {
    expect(suggest({ signal: null, sshCandidates: [sshTarget('dev-box', 'connected')] })).toBeNull()
  })

  it('stays silent when no candidate is healthy', () => {
    expect(
      suggest({
        remoteServerCandidates: [unverifiableRemoteServer('server-1')],
        sshCandidates: [sshTarget('dev-box', 'disconnected'), sshTarget('dev-box-2', null)]
      })
    ).toBeNull()
  })

  it('never treats an unanswered or ended pairing as healthy', () => {
    const candidates = [
      unverifiableRemoteServer('server-1'),
      refusedRemoteServer('server-2'),
      retiredRemoteServer('server-3')
    ]
    for (const candidate of candidates) {
      expect(suggest({ remoteServerCandidates: [candidate] })).toBeNull()
    }
  })

  it('never treats an SSH target as healthy while its connection is not connected', () => {
    const statuses: SshRunTargetCandidate['status'][] = [
      'disconnected',
      'connecting',
      'auth-failed',
      'deploying-relay',
      'reconnecting',
      'reconnection-failed',
      'error',
      null
    ]
    for (const status of statuses) {
      expect(suggest({ sshCandidates: [sshTarget('dev-box', status)] })).toBeNull()
    }
  })

  it('routes on a flag whose reason phrase is missing', () => {
    expect(
      suggest({
        signal: { onBattery: true, lowMemory: false, lowCpu: false, reasons: [] },
        sshCandidates: [sshTarget('dev-box', 'connected')]
      })
    ).toEqual({ hostId: 'ssh:dev-box', causes: ['onBattery'] })
  })

  it('names every true flag as a cause, in signal order', () => {
    expect(
      suggest({
        signal: { onBattery: true, lowMemory: true, lowCpu: true, reasons: [] },
        sshCandidates: [sshTarget('dev-box', 'connected')]
      })
    ).toEqual({ hostId: 'ssh:dev-box', causes: ['onBattery', 'lowMemory', 'lowCpu'] })
  })

  it('suggests a live remote server and carries the causes', () => {
    expect(suggest({ remoteServerCandidates: [liveRemoteServer('server-1')] })).toEqual({
      hostId: 'runtime:server-1',
      causes: ['onBattery', 'lowMemory']
    })
  })

  it('suggests a connected SSH target', () => {
    expect(suggest({ sshCandidates: [sshTarget('dev-box', 'connected')] })).toEqual({
      hostId: 'ssh:dev-box',
      causes: ['onBattery', 'lowMemory']
    })
  })

  it('skips unhealthy candidates in input order', () => {
    expect(
      suggest({
        remoteServerCandidates: [
          refusedRemoteServer('server-1'),
          unverifiableRemoteServer('server-2'),
          liveRemoteServer('server-3')
        ],
        sshCandidates: [sshTarget('dev-box', 'disconnected'), sshTarget('dev-box-2', 'connected')]
      })
    ).toEqual({
      hostId: 'runtime:server-3',
      causes: ['onBattery', 'lowMemory']
    })
  })

  it('prefers a healthy remote server over a connected SSH target', () => {
    expect(
      suggest({
        remoteServerCandidates: [liveRemoteServer('server-1')],
        sshCandidates: [sshTarget('dev-box', 'connected')]
      })
    ).toEqual({
      hostId: 'runtime:server-1',
      causes: ['onBattery', 'lowMemory']
    })
  })

  it('falls back to SSH when every remote server is unhealthy', () => {
    expect(
      suggest({
        remoteServerCandidates: [
          unverifiableRemoteServer('server-1'),
          retiredRemoteServer('server-2')
        ],
        sshCandidates: [sshTarget('dev-box', 'connected')]
      })
    ).toEqual({
      hostId: 'ssh:dev-box',
      causes: ['onBattery', 'lowMemory']
    })
  })
})
