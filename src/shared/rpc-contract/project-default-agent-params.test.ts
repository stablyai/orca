import { describe, expect, it } from 'vitest'
import { AgentResolveDefault } from './project-default-agent-params'

describe('agent.resolveDefault params', () => {
  it('accepts one host-qualified target and rejects ambiguous targets', () => {
    expect(AgentResolveDefault.safeParse({ repo: 'B', repoHostId: 'local' }).success).toBe(true)
    expect(
      AgentResolveDefault.parse({ repo: 'B', repoHostId: 'runtime:paired-host' }).repoHostId
    ).toBe('local')
    expect(AgentResolveDefault.safeParse({ repo: 'B', worktree: 'work' }).success).toBe(false)
    expect(AgentResolveDefault.safeParse({ repoHostId: 'local' }).success).toBe(false)
    expect(AgentResolveDefault.safeParse({ repo: 'B', repoHostId: 'bad-host' }).success).toBe(false)
    expect(AgentResolveDefault.safeParse({ repo: 'B', validateAgent: 'codex' }).success).toBe(true)
    expect(
      AgentResolveDefault.safeParse({ repo: 'B', validateAgent: 'not-an-agent' }).success
    ).toBe(false)
  })
})
