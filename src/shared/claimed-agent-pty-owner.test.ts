import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from './agent-session-host-authority'
import type { AgentStatusExecutionBinding } from './agent-status-run'
import {
  ClaimedAgentPtyOwnerRegistry,
  MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES
} from './claimed-agent-pty-owner'

function claim(
  identityDigest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  worktreeScopeDigest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
): AgentSessionExecutionClaim {
  return {
    digestVersion: 1,
    keyId: 'key',
    identityDigest,
    worktreeScopeDigest,
    agent: 'codex'
  }
}

const surface: AgentSessionSurfaceBinding = {
  worktreeId: 'worktree',
  tabId: 'tab',
  leafId: '12345678-1234-4234-8234-123456789abc',
  terminalHandle: 'term_handle'
}

function statusBinding(suffix: string): AgentStatusExecutionBinding {
  return {
    runId: `run-${suffix}`,
    attachment: { executionId: `execution-${suffix}` },
    role: 'root'
  }
}

describe('ClaimedAgentPtyOwnerRegistry', () => {
  it('joins concurrent exact ensures and spawns once', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    let finish!: (result: { ptyId: string }) => void
    const spawn = vi.fn(
      () =>
        new Promise<{ ptyId: string }>((resolve) => {
          finish = resolve
        })
    )

    const first = registry.ensure({ claim: claim(), surface, spawn })
    const second = registry.ensure({ claim: claim(), surface, spawn })
    finish({ ptyId: 'pty-1' })

    await expect(first).resolves.toMatchObject({ disposition: 'created' })
    await expect(second).resolves.toMatchObject({ disposition: 'adopted' })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect((await first).owner.statusBinding).toEqual((await second).owner.statusBinding)
  })

  it('conflicts when the same identity is claimed by another worktree', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-1' })
    })

    await expect(
      registry.ensure({
        claim: claim(
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'ccccccccccccccccccccccccccccccccccccccccccc'
        ),
        surface: { ...surface, worktreeId: 'other' },
        spawn: async () => ({ ptyId: 'pty-2' })
      })
    ).rejects.toThrow('agent_session_conflict')
  })

  it('does not find an owner through another worktree scope', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-1' })
    })

    expect(
      registry.find(
        claim(
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'ccccccccccccccccccccccccccccccccccccccccccc'
        )
      )
    ).toBeNull()
  })

  it('generation-guards release across a replacement owner', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const first = await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-1' })
    })

    registry.release('pty-1', 'stale-generation')
    expect(registry.find(claim())?.generation).toBe(first.owner.generation)

    registry.release('pty-1', first.owner.generation)
    expect(registry.find(claim())).toBeNull()
  })

  it('does not retain an owner when the spawned PTY already exited', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    let failedBinding: AgentStatusExecutionBinding | undefined

    await expect(
      registry.ensure({
        claim: claim(),
        surface,
        spawn: async ({ statusBinding: binding }) => {
          failedBinding = binding
          return { ptyId: 'pty-dead' }
        },
        isLive: () => false
      })
    ).rejects.toThrow('agent_session_exited_during_start')

    expect(registry.find(claim())).toBeNull()
    const retried = await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-retry' }),
      isLive: () => true
    })
    expect(retried.owner.ptyId).toBe('pty-retry')
    expect(retried.owner.statusBinding).not.toEqual(failedBinding)
  })

  it('mints a replacement binding with explicit run continuity', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const first = await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-old' })
    })

    const replacement = await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-new' }),
      isLive: (owner) => owner.ptyId !== 'pty-old'
    })

    expect(replacement.owner.statusBinding.runId).not.toBe(first.owner.statusBinding.runId)
    expect(replacement.owner.statusBinding.attachment.executionId).not.toBe(
      first.owner.statusBinding.attachment.executionId
    )
    expect(replacement.owner.statusBinding.continuityOf).toBe(first.owner.statusBinding.runId)
  })

  it('rejects a delayed discovery promotion after a newer host observation wins', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const first = await registry.ensure({
      claim: claim('a'.repeat(43)),
      surface,
      discoveryProcess: {
        ptyIncarnationId: '11111111-1111-4111-8111-111111111111',
        pid: 100,
        startTime: 'process-1',
        authorityGeneration: 'host-1',
        observationEpoch: 1,
        providerObservation: {
          authorityId: 'hooks-1',
          incarnation: 1,
          revision: 1,
          process: { pid: 201, startTime: 'old-start' }
        }
      },
      replaceDiscoveredPtyId: 'pty-1',
      spawn: async () => ({ ptyId: 'pty-1' })
    })
    let finishSecond!: (result: { ptyId: string }) => void
    let finishThird!: (result: { ptyId: string }) => void
    const second = registry.ensure({
      claim: claim('c'.repeat(43)),
      surface,
      discoveryProcess: {
        ptyIncarnationId: '11111111-1111-4111-8111-111111111111',
        pid: 101,
        startTime: 'process-2',
        authorityGeneration: 'host-1',
        observationEpoch: 2,
        providerObservation: {
          authorityId: 'hooks-1',
          incarnation: 1,
          revision: 2,
          process: { pid: 202, startTime: 'new-start' }
        }
      },
      replaceDiscoveredPtyId: 'pty-1',
      spawn: () =>
        new Promise((resolve) => {
          finishSecond = resolve
        })
    })
    const third = registry.ensure({
      claim: claim('d'.repeat(43)),
      surface,
      discoveryProcess: {
        ptyIncarnationId: '11111111-1111-4111-8111-111111111111',
        pid: 102,
        startTime: 'process-3',
        authorityGeneration: 'host-1',
        observationEpoch: 3,
        providerObservation: {
          authorityId: 'hooks-1',
          incarnation: 1,
          revision: 3,
          process: { pid: 203, startTime: 'newest-start' }
        }
      },
      replaceDiscoveredPtyId: 'pty-1',
      spawn: () =>
        new Promise((resolve) => {
          finishThird = resolve
        })
    })

    finishThird({ ptyId: 'pty-1' })
    const promotedThird = await third
    finishSecond({ ptyId: 'pty-1' })

    await expect(second).rejects.toThrow('agent_session_observation_stale')
    expect(promotedThird.owner.statusBinding.continuityOf).toBe(first.owner.statusBinding.runId)
    expect(registry.listForPty('pty-1')).toEqual([promotedThird.owner])
    registry.release('pty-1', first.owner.generation)
    expect(registry.listForPty('pty-1')).toEqual([promotedThird.owner])
  })

  it('does not promote a discovery over a managed owner registered during admission', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    let finishDiscovery!: (result: { ptyId: string }) => void
    const pending = registry.ensure({
      claim: claim('c'.repeat(43)),
      surface,
      discoveryProcess: {
        ptyIncarnationId: '11111111-1111-4111-8111-111111111111',
        pid: 101,
        startTime: 'process-2',
        authorityGeneration: 'host-1',
        observationEpoch: 2
      },
      replaceDiscoveredPtyId: 'pty-1',
      spawn: () =>
        new Promise((resolve) => {
          finishDiscovery = resolve
        })
    })
    const managed = {
      claim: claim('d'.repeat(43)),
      generation: 'managed-generation',
      phase: 'live' as const,
      ptyId: 'pty-1',
      surface,
      statusBinding: statusBinding('managed')
    }
    registry.register(managed)
    finishDiscovery({ ptyId: 'pty-1' })

    await expect(pending).rejects.toThrow('managed_owner_present')
    expect(registry.listForPty('pty-1')).toEqual([managed])
  })

  it('uses the lower execution host binding when it adopts an owner', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const canonicalBinding = statusBinding('host')
    let provisionalBinding: AgentStatusExecutionBinding | undefined

    const result = await registry.ensure({
      claim: claim(),
      surface,
      spawn: async ({ statusBinding: binding }) => {
        provisionalBinding = binding
        return {
          ptyId: 'pty-host',
          disposition: 'adopted',
          owner: {
            claim: claim(),
            generation: 'generation-host',
            phase: 'live',
            ptyId: 'pty-host',
            surface,
            statusBinding: canonicalBinding
          }
        }
      }
    })

    expect(result.owner.statusBinding).toEqual(canonicalBinding)
    expect(result.owner.statusBinding).not.toEqual(provisionalBinding)
  })

  it('rejects a lower owner that omits the execution binding', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()

    await expect(
      registry.ensure({
        claim: claim(),
        surface,
        spawn: async () => ({
          ptyId: 'pty-unbound',
          owner: {
            claim: claim(),
            generation: 'generation-unbound',
            phase: 'live',
            ptyId: 'pty-unbound',
            surface
          }
        })
      })
    ).rejects.toThrow('agent_session_ownership_unknown')
    expect(registry.find(claim())).toBeNull()
  })

  it('does not let a late liveness result adopt a released generation', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const created = await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-1' })
    })
    let finishProof!: (live: boolean) => void
    const adoption = registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-2' }),
      isLive: (owner) =>
        owner.ptyId === 'pty-1'
          ? new Promise<boolean>((resolve) => {
              finishProof = resolve
            })
          : true
    })

    registry.release('pty-1', created.owner.generation)
    finishProof(true)

    await expect(adoption).resolves.toMatchObject({
      disposition: 'created',
      owner: { ptyId: 'pty-2' }
    })
  })

  it('rejects a recovered owner that reuses only one half of its generation identity', () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const owner = {
      claim: claim(),
      generation: 'generation-1',
      phase: 'live' as const,
      ptyId: 'pty-1',
      surface,
      statusBinding: statusBinding('one')
    }
    registry.register(owner)

    expect(() => registry.register({ ...owner, ptyId: 'pty-2' })).toThrow('agent_session_conflict')
    expect(() => registry.register({ ...owner, generation: 'generation-2' })).toThrow(
      'agent_session_conflict'
    )
    expect(() =>
      registry.register({ ...owner, statusBinding: statusBinding('different') })
    ).toThrow('agent_session_ownership_unknown')
  })

  it('retains only allowlisted owner fields', () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const owner = {
      claim: { ...claim(), unknownPayload: 'claim payload' },
      generation: 'generation-1',
      phase: 'live' as const,
      ptyId: 'pty-1',
      surface: { ...surface, unknownPayload: 'surface payload' },
      statusBinding: { ...statusBinding('one'), unknownPayload: 'status payload' },
      unknownPayload: 'owner payload'
    }

    registry.register(owner)

    expect(registry.list()).toEqual([
      {
        claim: claim(),
        generation: 'generation-1',
        phase: 'live',
        ptyId: 'pty-1',
        surface,
        statusBinding: statusBinding('one')
      }
    ])
  })

  it('fails closed when recovered owner evidence reaches the process-wide cap', () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const owners = Array.from({ length: MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES }, (_, index) => ({
      claim: claim(`identity-${index}`),
      generation: `generation-${index}`,
      phase: 'live' as const,
      ptyId: `pty-${index}`,
      surface,
      statusBinding: statusBinding(String(index))
    }))
    registry.reconcileAuthoritative(owners)

    expect(() =>
      registry.register({
        claim: claim('one-more-identity'),
        generation: 'one-more-generation',
        phase: 'live',
        ptyId: 'one-more-pty',
        surface,
        statusBinding: statusBinding('one-more')
      })
    ).toThrow('execution_owner_unavailable')
    expect(registry.list()).toHaveLength(MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES)
  })

  it('atomically converges from conflicting provider evidence to one owner', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const ownerA = {
      claim: claim(),
      generation: 'generation-a',
      phase: 'live' as const,
      ptyId: 'pty-a',
      surface,
      statusBinding: statusBinding('a')
    }
    const ownerB = {
      ...ownerA,
      generation: 'generation-b',
      ptyId: 'pty-b'
    }

    registry.reconcileAuthoritative([ownerA, ownerB])
    await expect(
      registry.ensure({ claim: claim(), surface, spawn: async () => ({ ptyId: 'unexpected' }) })
    ).rejects.toThrow('agent_session_conflict')

    registry.reconcileAuthoritative([ownerB])
    await expect(
      registry.ensure({
        claim: claim(),
        surface,
        spawn: async () => ({ ptyId: 'unexpected' }),
        isLive: (owner) => owner.generation === ownerB.generation
      })
    ).resolves.toMatchObject({ disposition: 'adopted', owner: ownerB })
  })

  it('prunes an advertised generation when an authoritative snapshot omits it', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const recovered = {
      claim: claim(),
      generation: 'generation-old',
      phase: 'live' as const,
      ptyId: 'pty-reused',
      surface,
      statusBinding: statusBinding('old')
    }
    registry.reconcileAuthoritative([recovered])
    registry.reconcileAuthoritative([])

    const spawn = vi.fn(async () => ({ ptyId: 'pty-new' }))
    await expect(registry.ensure({ claim: claim(), surface, spawn })).resolves.toMatchObject({
      disposition: 'created',
      owner: { ptyId: 'pty-new' }
    })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('replaces a reused PTY id with the exact newly advertised generation', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const oldOwner = {
      claim: claim(),
      generation: 'generation-old',
      phase: 'live' as const,
      ptyId: 'pty-reused',
      surface,
      statusBinding: statusBinding('old')
    }
    const newOwner = { ...oldOwner, generation: 'generation-new' }
    registry.reconcileAuthoritative([oldOwner])
    registry.reconcileAuthoritative([newOwner])
    const isLive = vi.fn((owner: typeof newOwner) => owner.generation === 'generation-new')

    await expect(
      registry.ensure({
        claim: claim(),
        surface,
        spawn: async () => ({ ptyId: 'unexpected' }),
        isLive
      })
    ).resolves.toMatchObject({ disposition: 'adopted', owner: newOwner })
    expect(isLive).toHaveBeenCalledWith(expect.objectContaining({ generation: 'generation-new' }))
  })

  it('does not let reconciliation erase an in-flight reservation', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    let finish!: (result: { ptyId: string }) => void
    const spawn = vi.fn(
      () =>
        new Promise<{ ptyId: string }>((resolve) => {
          finish = resolve
        })
    )
    const first = registry.ensure({ claim: claim(), surface, spawn })

    registry.reconcileAuthoritative([])
    const second = registry.ensure({ claim: claim(), surface, spawn })
    finish({ ptyId: 'pty-reserved' })

    await expect(first).resolves.toMatchObject({ disposition: 'created' })
    await expect(second).resolves.toMatchObject({ disposition: 'adopted' })
    expect(spawn).toHaveBeenCalledOnce()
  })
})
