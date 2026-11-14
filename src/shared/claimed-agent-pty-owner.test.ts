import { describe, expect, it } from 'vitest'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from './agent-session/agent-session-host-authority'
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

  it('ignores a stale release generation and releases the matching owner', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const first = await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-1' })
    })

    registry.release('pty-1', 'stale-generation')
    expect(registry.find(claim())).toMatchObject({ ptyId: 'pty-1' })

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
    ).resolves.toMatchObject({
      disposition: 'adopted',
      owner: { ptyId: 'pty-b', generation: 'generation-b' }
    })
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

    const spawn = async () => ({ ptyId: 'pty-new' })
    await expect(registry.ensure({ claim: claim(), surface, spawn })).resolves.toMatchObject({
      disposition: 'created',
      owner: { ptyId: 'pty-new' }
    })
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
    const isLive = (owner: typeof newOwner) => owner.generation === 'generation-new'

    await expect(
      registry.ensure({
        claim: claim(),
        surface,
        spawn: async () => ({ ptyId: 'unexpected' }),
        isLive
      })
    ).resolves.toMatchObject({
      disposition: 'adopted',
      owner: { ptyId: 'pty-reused', generation: 'generation-new' }
    })
  })

  it('does not let reconciliation erase an in-flight reservation', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    let finish!: (result: { ptyId: string }) => void
    const spawn = () =>
      new Promise<{ ptyId: string }>((resolve) => {
        finish = resolve
      })
    const first = registry.ensure({ claim: claim(), surface, spawn })

    registry.reconcileAuthoritative([])
    const second = registry.ensure({ claim: claim(), surface, spawn })
    finish({ ptyId: 'pty-reserved' })

    await expect(first).resolves.toMatchObject({
      disposition: 'created',
      owner: { ptyId: 'pty-reserved' }
    })
    await expect(second).resolves.toMatchObject({
      disposition: 'adopted',
      owner: { ptyId: 'pty-reserved' }
    })
  })
})
