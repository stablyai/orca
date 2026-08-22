// Why (#11941): the planner is unit-tested next door; this asserts the override
// actually reaches the command string a remote Codex PTY runs, and that the
// local command — the one #8711's env injection already covers — is untouched.

import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { buildAgentResumeStartupPlan, buildAgentStartupPlan } from './tui-agent-startup'

const BASE = {
  cmdOverrides: {},
  platform: 'linux' as NodeJS.Platform,
  shell: 'posix' as const,
  agentStatusHookSettings: { agentStatusHooksEnabled: true }
}

describe('resolveAgentLaunchCommand — remote Codex hooks override', () => {
  it('adds the launch-scoped hooks override for a remote Codex launch', () => {
    const result = resolveAgentLaunchCommand({
      ...BASE,
      agent: 'codex',
      isRemote: true
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.command).toContain("'-c' 'features.hooks=true'")
  })

  it('keeps the local Codex command byte-for-byte unchanged', () => {
    const local = resolveAgentLaunchCommand({
      ...BASE,
      agent: 'codex',
      isRemote: false
    })
    const baseline = resolveAgentLaunchCommand({
      ...BASE,
      agent: 'codex',
      isRemote: false,
      agentStatusHookSettings: { agentStatusHooksEnabled: false }
    })
    expect(local.ok && baseline.ok && local.command).toBe(baseline.ok ? baseline.command : null)
    expect(local.ok && local.command).not.toContain('features.hooks')
  })

  it('keeps remote Claude unchanged', () => {
    const result = resolveAgentLaunchCommand({
      ...BASE,
      agent: 'claude',
      isRemote: true
    })
    expect(result.ok && result.command).not.toContain('features.hooks')
  })

  it('emits nothing when the user already disabled hooks in their CLI args', () => {
    const result = resolveAgentLaunchCommand({
      ...BASE,
      agent: 'codex',
      isRemote: true,
      agentArgs: '--disable hooks'
    })
    expect(result.ok && result.command).not.toContain('features.hooks=true')
  })

  it('emits nothing when a command override already decides hooks', () => {
    const result = resolveAgentLaunchCommand({
      ...BASE,
      agent: 'codex',
      cmdOverrides: { codex: 'codex -c features.hooks=false' },
      isRemote: true
    })
    expect(result.ok && result.command).not.toContain('features.hooks=true')
  })

  it('keeps the override ahead of the prompt on the argv launch path', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'do the thing',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      isRemote: true,
      agentStatusHookSettings: { agentStatusHooksEnabled: true }
    })
    expect(plan).not.toBeNull()
    const command = plan?.launchCommand ?? ''
    expect(command).toContain("'-c' 'features.hooks=true'")
    expect(command.indexOf('features.hooks=true')).toBeLessThan(command.indexOf('do the thing'))
  })

  it('omits the override for a remote Codex launch when hooks are disabled', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'do the thing',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      isRemote: true,
      agentStatusHookSettings: { agentStatusHooksEnabled: false }
    })
    expect(plan?.launchCommand).not.toContain('features.hooks')
  })

  // The named regression guard: a user who puts `-c features.hooks=false` in
  // their Codex default args must see exactly that, once, on the remote line.
  it('leaves a user hooks=false default args untouched, with one hooks decision', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'do the thing',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      isRemote: true,
      agentArgs: '-c features.hooks=false',
      agentStatusHookSettings: { agentStatusHooksEnabled: true }
    })
    const command = plan?.launchCommand ?? ''
    expect(command).toContain('features.hooks=false')
    expect(command).not.toContain('features.hooks=true')
    expect(command.match(/features\.hooks/g)).toHaveLength(1)
  })

  // Why: the flag used to be an optional boolean each launch surface derived for
  // itself, and most of them never did. These pin the derivation the builder now
  // owns, so a surface can only get it wrong by passing the wrong settings.
  it('honours the per-agent opt-out even when the global toggle is on', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'do the thing',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      isRemote: true,
      agentStatusHookSettings: { agentStatusHooksEnabled: true, disabledTuiAgents: ['codex'] }
    })
    expect(plan?.launchCommand).not.toContain('features.hooks')
  })

  it('treats absent settings as the shipped default, which is hooks on', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'do the thing',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      isRemote: true,
      agentStatusHookSettings: null
    })
    expect(plan?.launchCommand).toContain("'-c' 'features.hooks=true'")
  })

  it('carries the override into a remote Codex resume', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: '9f3d1c2e-0000-4000-8000-000000000001' },
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      isRemote: true,
      agentStatusHookSettings: { agentStatusHooksEnabled: true }
    })
    expect(plan?.launchCommand).toContain("'-c' 'features.hooks=true'")
  })

  it('leaves a local Codex resume without the override', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: '9f3d1c2e-0000-4000-8000-000000000001' },
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      isRemote: false,
      agentStatusHookSettings: { agentStatusHooksEnabled: true }
    })
    expect(plan?.launchCommand).not.toContain('features.hooks')
  })

  it('does not overrule a user who disabled hooks in their resume CLI args', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: '9f3d1c2e-0000-4000-8000-000000000001' },
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      isRemote: true,
      agentArgs: '-c features.hooks=false',
      agentStatusHookSettings: { agentStatusHooksEnabled: true }
    })
    expect(plan?.launchCommand).toContain('features.hooks=false')
    expect(plan?.launchCommand).not.toContain('features.hooks=true')
  })
})
