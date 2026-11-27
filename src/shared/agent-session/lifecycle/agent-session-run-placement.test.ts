import { describe, expect, it } from 'vitest'
import { agentSessionRunPlacement } from './agent-session-run-placement'

const relayed = {
  fence: 3,
  kind: 'relayed',
  relayId: 'relay-1',
  daemon: { instance: 'start-1', pid: 41, startedAtMs: 1_000 },
  agent: { hostId: 'local', pid: 42, processStartTimeMs: null, spawnToken: 'token' }
}

describe('agentSessionRunPlacement', () => {
  it('keeps a pooled run’s workload, so a later app stops the commands it started', () => {
    expect(
      agentSessionRunPlacement({ lastRunPlacement: { ...relayed, workload: 'lease-1' } })
    ).toEqual({ ...relayed, workload: 'lease-1' })
  })

  it('reads a malformed workload as none, keeping the placement', () => {
    expect(agentSessionRunPlacement({ lastRunPlacement: { ...relayed, workload: 7 } })).toEqual(
      relayed
    )
  })
})
