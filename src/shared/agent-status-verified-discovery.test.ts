import { describe, expect, it } from 'vitest'
import type { AgentSessionExecutionClaim } from './agent-session-host-authority'
import { ClaimedAgentPtyOwnerRegistry } from './claimed-agent-pty-owner'
import {
  admitVerifiedAgentDiscovery,
  isVerifiedAgentDiscovery,
  type VerifiedAgentDiscovery
} from './agent-status-verified-discovery'

function makeClaim(identityCharacter: string): AgentSessionExecutionClaim {
  return {
    digestVersion: 1,
    keyId: 'verified-discovery-test',
    identityDigest: identityCharacter.repeat(43),
    worktreeScopeDigest: 'b'.repeat(43),
    agent: 'codex'
  }
}

const claim = makeClaim('a')

const surface = {
  worktreeId: 'repo::/tmp/worktree',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  terminalHandle: `term_${'a'.repeat(32)}`
}

function discovery(overrides: Partial<VerifiedAgentDiscovery> = {}): VerifiedAgentDiscovery {
  return {
    claim,
    surface,
    evidence: {
      verdict: 'live',
      processName: 'codex',
      authorityGeneration: 'host-generation-1',
      observationEpoch: 7,
      capturedAgeMs: 0,
      ptyId: 'pty-1',
      ptyIncarnationId: '22222222-2222-4222-8222-222222222222',
      fence: {
        platform: 'posix',
        shellPid: 100,
        shellStartTime: 'shell-start-1',
        tty: '/dev/ttys001',
        foregroundPgid: 200,
        process: { pid: 200, startTime: 'agent-start-1' }
      }
    },
    providerIdentity: {
      agent: 'codex',
      source: 'provider-session',
      session: { key: 'session_id', id: 'codex-session-1' },
      observation: {
        authorityId: 'hooks-1',
        incarnation: 1,
        revision: 1,
        process: { pid: 200, startTime: 'agent-start-1' }
      }
    },
    ancestry: {
      parent: { pid: 100, startTime: 'shell-start-1' },
      chain: [{ pid: 100, startTime: 'shell-start-1' }],
      relation: 'direct-child'
    },
    process: { pid: 200, startTime: 'agent-start-1', parentPid: 100 },
    ...overrides
  }
}

describe('verified agent discovery admission', () => {
  it('rejects malformed inventory values before admission', () => {
    expect(isVerifiedAgentDiscovery({ verdict: 'live' })).toBe(false)
  })

  it('adopts a live process through the existing owner transaction', async () => {
    const owners = new ClaimedAgentPtyOwnerRegistry()
    const result = await admitVerifiedAgentDiscovery({ owners, discovery: discovery() })

    expect(result).toMatchObject({ admitted: true, disposition: 'adopted' })
    if (!result.admitted) {
      return
    }
    expect(result.owner.ptyId).toBe('pty-1')
    expect(result.owner.surface).toEqual(surface)
    expect(result.owner.statusBinding.role).toBe('root')
    expect(result.owner.discoveryProcess).toEqual({
      ptyIncarnationId: '22222222-2222-4222-8222-222222222222',
      pid: 200,
      startTime: 'agent-start-1',
      authorityGeneration: 'host-generation-1',
      observationEpoch: 7,
      providerObservation: {
        authorityId: 'hooks-1',
        incarnation: 1,
        revision: 1,
        process: { pid: 200, startTime: 'agent-start-1' }
      }
    })
    expect(owners.find(claim)?.statusBinding).toEqual(result.owner.statusBinding)
  })

  it('accepts a multiplexer child only with an explicit host ancestry chain', async () => {
    const owners = new ClaimedAgentPtyOwnerRegistry()
    const candidate = discovery({
      ancestry: {
        parent: { pid: 150, startTime: 'tmux-start-1' },
        chain: [
          { pid: 100, startTime: 'shell-start-1' },
          { pid: 150, startTime: 'tmux-start-1' }
        ],
        relation: 'multiplexer-child'
      },
      process: { pid: 200, startTime: 'agent-start-1', parentPid: 150 }
    })

    await expect(
      admitVerifiedAgentDiscovery({ owners, discovery: candidate })
    ).resolves.toMatchObject({
      admitted: true
    })
  })

  it('rejects title/process-name mismatches and incomplete ancestry without touching owners', async () => {
    const owners = new ClaimedAgentPtyOwnerRegistry()
    const liveEvidence = discovery().evidence
    if (liveEvidence.verdict !== 'live') {
      throw new Error('expected live fixture')
    }
    if (liveEvidence.fence.platform !== 'posix') {
      throw new Error('expected posix fixture')
    }
    const foreign = discovery({
      evidence: { ...liveEvidence, processName: 'claude' }
    })
    const incomplete = discovery({
      ancestry: {
        parent: { pid: 150, startTime: 'tmux-start-1' },
        chain: [{ pid: 100, startTime: 'shell-start-1' }],
        relation: 'descendant'
      }
    })

    await expect(
      admitVerifiedAgentDiscovery({ owners, discovery: foreign })
    ).resolves.toMatchObject({
      admitted: false,
      reason: 'provider_identity_mismatch'
    })
    await expect(
      admitVerifiedAgentDiscovery({ owners, discovery: incomplete })
    ).resolves.toMatchObject({ admitted: false, reason: 'ancestry_proof_incomplete' })
    expect(owners.list()).toEqual([])
  })

  it('does not replace a managed launch owner with process discovery', async () => {
    const owners = new ClaimedAgentPtyOwnerRegistry()
    const managedClaim = makeClaim('c')
    owners.register({
      claim: managedClaim,
      generation: 'managed-generation',
      phase: 'live',
      ptyId: 'pty-1',
      surface,
      statusBinding: {
        runId: 'managed-run',
        attachment: { executionId: 'managed-execution' },
        role: 'root'
      }
    })

    await expect(
      admitVerifiedAgentDiscovery({ owners, discovery: discovery() })
    ).resolves.toMatchObject({ admitted: false, reason: 'managed_owner_present' })
    expect(owners.listForPty('pty-1')).toHaveLength(1)
    expect(owners.find(managedClaim)?.statusBinding.runId).toBe('managed-run')
  })

  it('preserves unverifiable and exited verdicts instead of admitting them', async () => {
    const owners = new ClaimedAgentPtyOwnerRegistry()
    const unverifiable = discovery({
      evidence: {
        ...discovery().evidence,
        verdict: 'unverifiable',
        reason: 'process_table_unreadable'
      }
    })
    const exited = discovery({
      evidence: {
        ...discovery().evidence,
        verdict: 'exited',
        reason: 'pty_exit_1'
      }
    })

    await expect(admitVerifiedAgentDiscovery({ owners, discovery: unverifiable })).resolves.toEqual(
      {
        admitted: false,
        verdict: 'unverifiable',
        reason: 'process_table_unreadable'
      }
    )
    await expect(admitVerifiedAgentDiscovery({ owners, discovery: exited })).resolves.toEqual({
      admitted: false,
      verdict: 'exited',
      reason: 'pty_exit_1'
    })
    expect(owners.list()).toEqual([])
  })

  it('replaces a stale incarnation without allowing the old generation to settle it', async () => {
    const owners = new ClaimedAgentPtyOwnerRegistry()
    const first = await admitVerifiedAgentDiscovery({ owners, discovery: discovery() })
    if (!first.admitted) {
      throw new Error('expected first admission')
    }
    const liveEvidence = discovery().evidence
    if (liveEvidence.verdict !== 'live') {
      throw new Error('expected live fixture')
    }
    if (liveEvidence.fence.platform !== 'posix') {
      throw new Error('expected posix fixture')
    }
    const replacement = discovery({
      claim: makeClaim('d'),
      evidence: {
        ...liveEvidence,
        ptyIncarnationId: '33333333-3333-4333-8333-333333333333',
        fence: {
          ...liveEvidence.fence,
          process: { pid: 200, startTime: 'agent-start-2' }
        }
      },
      providerIdentity: {
        ...discovery().providerIdentity,
        observation: {
          authorityId: 'hooks-1',
          incarnation: 1,
          revision: 2,
          process: { pid: 200, startTime: 'agent-start-2' }
        }
      },
      process: { pid: 200, startTime: 'agent-start-2', parentPid: 100 }
    })
    const second = await admitVerifiedAgentDiscovery({
      owners,
      discovery: replacement,
      isLive: () => true
    })
    if (!second.admitted) {
      throw new Error('expected replacement admission')
    }
    expect(second.owner.generation).not.toBe(first.owner.generation)
    expect(second.owner.discoveryProcess?.startTime).toBe('agent-start-2')
    expect(second.owner.statusBinding.continuityOf).toBe(first.owner.statusBinding.runId)
    owners.release(first.owner.ptyId, first.owner.generation)
    expect(owners.find(replacement.claim)?.generation).toBe(second.owner.generation)
  })

  it('refuses to attach a cached provider observation to a replacement process', async () => {
    const owners = new ClaimedAgentPtyOwnerRegistry()
    const first = await admitVerifiedAgentDiscovery({ owners, discovery: discovery() })
    if (!first.admitted) {
      throw new Error('expected first admission')
    }
    const liveEvidence = discovery().evidence
    if (liveEvidence.verdict !== 'live' || liveEvidence.fence.platform !== 'posix') {
      throw new Error('expected posix live fixture')
    }
    const replacement = discovery({
      claim: makeClaim('e'),
      evidence: {
        ...liveEvidence,
        fence: {
          ...liveEvidence.fence,
          process: { pid: 201, startTime: 'agent-start-2' }
        }
      },
      process: { pid: 201, startTime: 'agent-start-2', parentPid: 100 }
    })

    await expect(
      admitVerifiedAgentDiscovery({ owners, discovery: replacement })
    ).resolves.toMatchObject({
      admitted: false,
      reason: 'agent_session_observation_stale'
    })
    expect(owners.listForPty('pty-1')).toEqual([first.owner])
  })
})
