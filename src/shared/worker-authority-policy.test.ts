import { describe, expect, it } from 'vitest'
import {
  NO_GITHUB_AUTHORITY_POLICY,
  consumeWorkerAuthorityPolicyCapability,
  isNoGithubAuthorityPolicySupported,
  issueWorkerAuthorityPolicyCapability
} from './worker-authority-policy'

describe('worker authority policy capability', () => {
  it('does not advertise enforcement from platform shape alone', () => {
    expect(
      isNoGithubAuthorityPolicySupported({
        agent: 'codex',
        platform: 'darwin'
      })
    ).toBe(false)
    expect(
      isNoGithubAuthorityPolicySupported({
        agent: 'codex',
        platform: 'darwin',
        processOwnerSupportsIsolation: true
      })
    ).toBe(true)
  })

  it('binds a short-lived capability to runtime and agent and consumes it once', () => {
    const issued = issueWorkerAuthorityPolicyCapability({
      runtimeId: 'runtime-a',
      agentId: 'claude',
      worktreeId: 'worktree-a',
      setupPolicy: 'skip',
      now: 1_000
    })

    expect(issued).toMatchObject({
      policy: NO_GITHUB_AUTHORITY_POLICY,
      runtimeId: 'runtime-a',
      agentId: 'claude',
      worktreeId: 'worktree-a',
      setupPolicy: 'skip',
      enforcement: 'available'
    })
    expect(issued.capabilityRef).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(
      consumeWorkerAuthorityPolicyCapability({
        capabilityRef: issued.capabilityRef,
        policy: issued.policy,
        runtimeId: 'runtime-a',
        agentId: 'codex',
        worktreeId: 'worktree-a',
        setupPolicy: 'skip',
        now: 2_000
      })
    ).toBeNull()
    expect(
      consumeWorkerAuthorityPolicyCapability({
        capabilityRef: issued.capabilityRef,
        policy: issued.policy,
        runtimeId: 'runtime-a',
        agentId: 'claude',
        worktreeId: 'worktree-a',
        setupPolicy: 'skip',
        now: 2_000
      })
    ).toMatchObject({ capabilityRef: issued.capabilityRef })
    expect(
      consumeWorkerAuthorityPolicyCapability({
        capabilityRef: issued.capabilityRef,
        policy: issued.policy,
        runtimeId: 'runtime-a',
        agentId: 'claude',
        worktreeId: 'worktree-a',
        setupPolicy: 'skip',
        now: 2_001
      })
    ).toBeNull()
  })

  it('rejects expired capabilities', () => {
    const issued = issueWorkerAuthorityPolicyCapability({
      runtimeId: 'runtime-b',
      agentId: 'codex',
      worktreeId: 'worktree-b',
      setupPolicy: 'skip',
      now: 10_000
    })
    expect(
      consumeWorkerAuthorityPolicyCapability({
        capabilityRef: issued.capabilityRef,
        policy: issued.policy,
        runtimeId: 'runtime-b',
        agentId: 'codex',
        worktreeId: 'worktree-b',
        setupPolicy: 'skip',
        now: Date.parse(issued.expiresAt)
      })
    ).toBeNull()
  })
})
