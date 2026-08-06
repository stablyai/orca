import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan, buildAgentStartupPlan } from './tui-agent-startup'

describe('remote Codex hook launch', () => {
  it('enables hooks only when a remote Codex PTY exposes Orca hook coordinates', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: '--dangerously-bypass-approvals-and-sandbox',
      platform: 'darwin',
      isRemote: true
    })

    expect(plan?.launchCommand).toBe(
      "codex ${ORCA_AGENT_HOOK_PORT:+--enable hooks} '--dangerously-bypass-approvals-and-sandbox' 'fix it'"
    )
    expect(plan?.launchConfig.agentCommand).toBe(
      "codex ${ORCA_AGENT_HOOK_PORT:+--enable hooks} '--dangerously-bypass-approvals-and-sandbox'"
    )
  })

  it('preserves an explicit remote Codex hooks disable override', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: '--dangerously-bypass-approvals-and-sandbox --disable hooks',
      platform: 'linux',
      isRemote: true
    })

    expect(plan?.launchCommand).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' '--disable' 'hooks' 'fix it'"
    )
  })

  it('preserves an explicit remote Codex hooks config in a command override', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: { codex: 'codex --config features.hooks=false' },
      platform: 'linux',
      isRemote: true
    })

    expect(plan?.launchCommand).toBe("codex --config features.hooks=false 'fix it'")
  })

  it('does not alter local Codex launches', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'darwin'
    })

    expect(plan?.launchCommand).toBe("codex 'fix it'")
  })

  it('does not add POSIX hook arguments to Windows remotes', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'win32',
      isRemote: true
    })

    expect(plan?.launchCommand).toBe("codex 'fix it'")
  })

  it('upgrades a captured remote Codex command when resuming an older session', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      agentCommand: 'codex --profile captured',
      platform: 'linux',
      isRemote: true
    })

    expect(plan?.launchCommand).toBe(
      "codex --profile captured ${ORCA_AGENT_HOOK_PORT:+--enable hooks} 'resume' 's1'"
    )
    expect(plan?.launchConfig.agentCommand).toBe(
      'codex --profile captured ${ORCA_AGENT_HOOK_PORT:+--enable hooks}'
    )
  })

  it('does not duplicate the remote hook guard in a captured command', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      agentCommand: 'codex ${ORCA_AGENT_HOOK_PORT:+--enable hooks}',
      platform: 'linux',
      isRemote: true
    })

    expect(plan?.launchCommand).toBe("codex ${ORCA_AGENT_HOOK_PORT:+--enable hooks} 'resume' 's1'")
  })
})
