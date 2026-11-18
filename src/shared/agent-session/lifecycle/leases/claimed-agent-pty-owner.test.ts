import { describe, expect, it } from 'vitest'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../operations/agent-session-host-authority'
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
