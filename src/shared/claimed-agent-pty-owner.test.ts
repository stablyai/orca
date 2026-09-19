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
import type { LiveAgentSessionOwner } from './claimed-agent-pty-owner-snapshot'

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

    const firstBinding = first.owner.statusBinding
    const replacementBinding = replacement.owner.statusBinding
    expect(firstBinding).toBeDefined()
    expect(replacementBinding).toBeDefined()
    expect(replacementBinding?.runId).not.toBe(firstBinding?.runId)
    expect(replacementBinding?.attachment.executionId).not.toBe(
      firstBinding?.attachment.executionId
    )
    expect(replacementBinding?.continuityOf).toBe(firstBinding?.runId)
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

  it('keeps its own binding when a lower host returns an owner without one', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()

    // A host that predates run identity is still a valid owner. For a fresh create this host
    // already stamped its binding into the spawn env, so that binding stays authoritative.
    const created = await registry.ensure({
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

    expect(created.disposition).toBe('created')
    expect(created.owner.statusBinding?.runId).toEqual(expect.any(String))
    expect(registry.find(claim())).not.toBeNull()
  })

  it('leaves identity absent when it adopts a lower owner that has none', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()

    // Adoption must report what the lower host actually holds. Inventing a binding here would
    // name a run whose process never received it, which reads as identity the host cannot prove.
    const adopted = await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({
        ptyId: 'pty-adopted',
        disposition: 'adopted',
        owner: {
          claim: claim(),
          generation: 'generation-adopted',
          phase: 'live',
          ptyId: 'pty-adopted',
          surface
        }
      })
    })

    expect(adopted.disposition).toBe('adopted')
    expect(adopted.owner.statusBinding).toBeUndefined()
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
    const isLive = vi.fn((owner: LiveAgentSessionOwner) => owner.generation === 'generation-new')

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
