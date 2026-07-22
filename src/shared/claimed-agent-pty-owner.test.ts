import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from './agent-session-host-authority'
import { ClaimedAgentPtyOwnerRegistry } from './claimed-agent-pty-owner'

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

    await expect(
      registry.ensure({
        claim: claim(),
        surface,
        spawn: async () => ({ ptyId: 'pty-dead' }),
        isLive: () => false
      })
    ).rejects.toThrow('agent_session_exited_during_start')

    expect(registry.find(claim())).toBeNull()
    await expect(
      registry.ensure({
        claim: claim(),
        surface,
        spawn: async () => ({ ptyId: 'pty-retry' }),
        isLive: () => true
      })
    ).resolves.toMatchObject({ owner: { ptyId: 'pty-retry' } })
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
      surface
    }
    registry.register(owner)

    expect(() => registry.register({ ...owner, ptyId: 'pty-2' })).toThrow('agent_session_conflict')
    expect(() => registry.register({ ...owner, generation: 'generation-2' })).toThrow(
      'agent_session_conflict'
    )
  })

  it('atomically converges from conflicting provider evidence to one owner', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const ownerA = {
      claim: claim(),
      generation: 'generation-a',
      phase: 'live' as const,
      ptyId: 'pty-a',
      surface
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
      surface
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
      surface
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
