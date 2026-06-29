import { describe, expect, it } from 'vitest'
import { planSourceControlAgentActionLaunch } from './source-control-agent-action-plan'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

const windowsHostProjectRuntime: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'windows-host',
    hostPlatform: 'win32',
    projectId: 'project-1',
    reason: 'project-override',
    cacheKey: 'project-1:windows-host:project-override'
  }
}

describe('planSourceControlAgentActionLaunch', () => {
  it('rejects disabled agents', () => {
    expect(
      planSourceControlAgentActionLaunch({
        agent: 'codex',
        commandInput: 'Fix checks',
        promptDelivery: 'submit-after-ready',
        detectedAgents: ['codex'],
        disabledAgents: ['codex'],
        platform: 'darwin'
      })
    ).toEqual({ ok: false, error: 'The selected agent is disabled in Settings.' })
  })

  it('rejects agents not detected on the current host', () => {
    expect(
      planSourceControlAgentActionLaunch({
        agent: 'claude',
        commandInput: 'Fix checks',
        promptDelivery: 'submit-after-ready',
        detectedAgents: ['codex'],
        platform: 'linux'
      })
    ).toEqual({ ok: false, error: 'The selected agent was not detected on this workspace host.' })
  })

  it('mirrors submit-after-ready delivery without embedding the prompt in the command', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'codex',
      commandInput: 'Fix checks',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['codex'],
      platform: 'linux'
    })

    expect(result.ok && result.delivery).toBe('paste-submit')
    expect(result.ok && result.commandLabel).toBe('codex')
    expect(result.ok && result.summary).toContain('pastes and submits')
    expect(result.ok && result.caveat).toContain('PATH')
  })

  it('includes per-action CLI arguments in submit-after-ready launch plans', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'codex',
      commandInput: 'Fix checks',
      agentArgs: '--model gpt-5.5',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['codex'],
      platform: 'linux'
    })

    expect(result.ok && result.commandLabel).toBe("codex '--model' 'gpt-5.5'")
  })

  it('does not apply the local Windows terminal shell to runtime-owned launch plans', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'codex',
      commandInput: 'Fix checks',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['codex'],
      platform: 'win32',
      terminalWindowsShell: 'git-bash',
      launchHost: { connectionId: null, executionHostId: 'runtime:host-1' }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.plan.launchCommand).toContain('function __orca_codex_start')
    expect(result.plan.launchCommand).not.toMatch(/^sh -c /)
  })

  it('uses the plain Orca shim for SSH execution-host launch plans', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'claude-agent-teams',
      commandInput: 'Fix checks',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['claude-agent-teams'],
      platform: 'linux',
      launchHost: { connectionId: null, executionHostId: 'ssh:ssh-1' }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.commandLabel).toBe('orca claude-teams')
    expect(result.commandLabel).not.toContain('orca-ide')
  })

  it('previews local Windows host launch plans with the runtime shell fallback', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'codex',
      commandInput: 'Fix checks',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['codex'],
      platform: 'win32',
      terminalWindowsShell: 'wsl.exe',
      launchHost: { connectionId: null, executionHostId: 'local' },
      projectRuntime: windowsHostProjectRuntime
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.plan.launchCommand).toContain('function __orca_codex_start')
    expect(result.commandLabel).toBe('codex')
  })

  it('rejects invalid per-action CLI arguments', () => {
    expect(
      planSourceControlAgentActionLaunch({
        agent: 'codex',
        commandInput: 'Fix checks',
        agentArgs: '--model "unterminated',
        promptDelivery: 'submit-after-ready',
        detectedAgents: ['codex'],
        platform: 'linux'
      })
    ).toEqual({
      ok: false,
      error: 'CLI arguments are invalid: Unclosed quote in command template.'
    })
  })

  it('uses native draft launch when the selected agent supports it', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'claude',
      commandInput: 'Fix checks',
      promptDelivery: 'draft',
      detectedAgents: ['claude'],
      platform: 'darwin'
    })

    expect(result.ok && result.delivery).toBe('draft-native')
    expect(result.ok && result.commandLabel).toContain('--prefill')
  })
})
