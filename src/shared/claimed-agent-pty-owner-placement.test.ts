import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerBinding } from './agent-session-host-authority'
import { ClaimedAgentPtyOwnerRegistry } from './claimed-agent-pty-owner'

const claim = {
  digestVersion: 1 as const,
  keyId: 'synthetic-key',
  agent: 'claude' as const,
  identityDigest: 'writer',
  worktreeScopeDigest: 'workspace-a'
}
const surface = {
  worktreeId: 'workspace-a',
  tabId: 'tab-a',
  leafId: 'leaf-a',
  terminalHandle: 'term_a'
}
const otherClaim = { ...claim, worktreeScopeDigest: 'workspace-b' }
const otherSurface = { ...surface, worktreeId: 'workspace-b', tabId: 'tab-b' }

describe('provider writer ownership independent of requested placement', () => {
  it('joins a cross-workspace reservation without changing the incumbent binding', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    let finish!: (result: { ptyId: string }) => void
    const spawn = vi.fn(() => new Promise<{ ptyId: string }>((resolve) => (finish = resolve)))
    const first = registry.ensure({ claim, surface, spawn })
    const second = registry.ensure({ claim: otherClaim, surface: otherSurface, spawn })
    finish({ ptyId: 'pty-a' })
    const created = await first
    expect(await second).toEqual({ disposition: 'adopted', owner: created.owner })
    expect(spawn).toHaveBeenCalledOnce()
    expect(registry.find(otherClaim)).toEqual(created.owner)
  })

  it('promotes a daemon adoption and recovers serialized evidence into a new controller', async () => {
    const daemon = new ClaimedAgentPtyOwnerRegistry()
    const incumbent = await daemon.ensure({
      claim,
      surface,
      spawn: async () => ({ ptyId: 'pty-a' })
    })
    const controller = new ClaimedAgentPtyOwnerRegistry()
    const physicalSpawn = vi.fn(async () => ({ ptyId: 'duplicate' }))
    const result = await controller.ensure({
      claim: otherClaim,
      surface: otherSurface,
      spawn: async () => {
        const adopted = await daemon.ensure({
          claim: otherClaim,
          surface: otherSurface,
          spawn: physicalSpawn
        })
        return { ...adopted, ptyId: adopted.owner.ptyId }
      }
    })
    expect(result).toEqual({ disposition: 'adopted', owner: incumbent.owner })
    const restartedController = new ClaimedAgentPtyOwnerRegistry()
    restartedController.reconcileAuthoritative(JSON.parse(JSON.stringify(daemon.list())))
    expect(
      await restartedController.ensure({
        claim: otherClaim,
        surface: otherSurface,
        spawn: physicalSpawn
      })
    ).toEqual(result)
    expect(physicalSpawn).not.toHaveBeenCalled()
  })

  it.each(['scope', 'surface'] as const)('refuses forged fresh owner %s', async (field) => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    await expect(
      registry.ensure({
        claim,
        surface,
        spawn: async ({ generation }) => ({
          ptyId: 'pty-a',
          owner: {
            claim: field === 'scope' ? otherClaim : claim,
            surface: field === 'surface' ? otherSurface : surface,
            generation,
            ptyId: 'pty-a',
            phase: 'live'
          }
        })
      })
    ).rejects.toThrow('agent_session_ownership_unknown')
    expect(registry.list()).toEqual([])
  })

  it('refuses rewritten incumbent placement in a recovered snapshot', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const created = await registry.ensure({
      claim,
      surface,
      spawn: async () => ({ ptyId: 'pty-a' })
    })
    const rewritten: AgentSessionOwnerBinding = {
      ...created.owner,
      claim: otherClaim,
      surface: otherSurface
    }
    expect(() => registry.reconcileAuthoritative([created.owner, rewritten])).toThrow(
      'agent_session_ownership_unknown'
    )
    expect(registry.find(otherClaim)).toEqual(created.owner)
  })
})
