import { describe, expect, it } from 'vitest'
import { resolveRemoteWorktreeCreateLaunchParams } from './worktree-create-launch-compat'
import type { AgentLaunchSpawnRequest } from '../../../shared/agent-launch-spawn-request'

const supported = () => Promise.resolve(true)
const unsupported = () => Promise.resolve(false)

function identityLaunch(
  selection: AgentLaunchSpawnRequest['selection'],
  prompt?: string
): AgentLaunchSpawnRequest {
  return { selection, ...(prompt !== undefined ? { prompt } : {}) }
}

describe('resolveRemoteWorktreeCreateLaunchParams', () => {
  it('passes no launch through untouched', async () => {
    expect(await resolveRemoteWorktreeCreateLaunchParams(undefined, unsupported)).toEqual({})
  })

  it('sends identity-only agentLaunch to a capable host', async () => {
    const launch = identityLaunch({ kind: 'agent', agent: 'claude' }, 'hello')
    expect(await resolveRemoteWorktreeCreateLaunchParams(launch, supported)).toEqual({
      agentLaunch: launch
    })
  })

  it('falls back to the legacy startupAgent id for a built-in on a pre-identity host', async () => {
    const launch = identityLaunch({ kind: 'agent', agent: 'claude' }, 'hello')
    expect(await resolveRemoteWorktreeCreateLaunchParams(launch, unsupported)).toEqual({
      startupAgent: 'claude',
      startupPrompt: 'hello'
    })
  })

  it('fails fast for a stored-default selection on a pre-identity host', async () => {
    await expect(
      resolveRemoteWorktreeCreateLaunchParams(identityLaunch({ kind: 'default' }), unsupported)
    ).rejects.toThrow(/predates default-agent launch/)
  })

  it('fails fast for a custom id on a pre-identity host — never a client-assembled command', async () => {
    await expect(
      resolveRemoteWorktreeCreateLaunchParams(
        identityLaunch({ kind: 'agent', agent: 'custom-agent:claude:abc' }),
        unsupported
      )
    ).rejects.toThrow(/predates custom agents/)
  })
})
