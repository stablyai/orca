import { describe, expect, it } from 'vitest'
import { structuredLaunchIdentity } from './structured-agent-session-launch-registry'
import { structuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import type { AgentLaunchProfile, ProfileAgent } from '../../../shared/agent-launch-profile'
describe.each(['claude', 'codex'] as const)('%s profile launch identity', (agent: ProfileAgent) => {
  const a: AgentLaunchProfile = {
    id: 'work',
    name: 'Work',
    agent,
    hostId: 'local',
    executable: `/bin/${agent}`,
    binding: { kind: 'managed', accountId: 'a' }
  }
  const b: AgentLaunchProfile = {
    ...a,
    id: 'personal',
    binding: { kind: 'managed', accountId: 'b' }
  }
  it('separates providers, hosts, profile A/B and rebound accounts while ignoring renames and CLI updates', () => {
    const key = structuredLaunchIdentity('folder:workspace', agent, undefined, a)
    expect(key).not.toBe(structuredLaunchIdentity('folder:workspace', agent, undefined, b))
    expect(key).not.toBe(
      structuredLaunchIdentity('folder:workspace', agent, undefined, { ...a, binding: b.binding })
    )
    expect(key).not.toBe(
      structuredLaunchIdentity('folder:workspace', agent, undefined, { ...a, hostId: 'ssh:other' })
    )
    expect(key).not.toBe(
      structuredLaunchIdentity(
        'folder:workspace',
        agent === 'claude' ? 'codex' : 'claude',
        undefined,
        a
      )
    )
    expect(key).toBe(
      structuredLaunchIdentity('folder:workspace', agent, undefined, {
        ...a,
        name: 'Renamed',
        executable: '/new/cli'
      })
    )
    expect(key).not.toBe(structuredLaunchIdentity('folder:workspace', agent))
  })
  it('sends a profile ID in the fingerprint instead of a renderer-supplied binding', () => {
    const input = {
      sessionId: `${agent}_session1`,
      worktree: 'folder:workspace',
      agent,
      now: 1_800_000_000_000,
      randomUuid: () => '00000000-0000-4000-8000-000000000001'
    }
    const first = structuredAgentSessionCreateParams({ ...input, agentProfileId: a.id })
    expect(first.envelope.payloadFingerprint).not.toBe(
      structuredAgentSessionCreateParams({ ...input, agentProfileId: b.id }).envelope
        .payloadFingerprint
    )
    expect(first).toHaveProperty('agentProfileId', a.id)
    expect(first).not.toHaveProperty('agentProfile')
  })
})
