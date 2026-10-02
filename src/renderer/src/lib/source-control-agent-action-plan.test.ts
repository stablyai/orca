import { describe, expect, it } from 'vitest'
import { planSourceControlAgentActionLaunch } from './source-control-agent-action-plan'

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

  it('carries a submit-after-ready prompt on the command line of an agent that takes one', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'codex',
      commandInput: 'Fix checks',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['codex'],
      platform: 'linux'
    })

    expect(result.ok && result.delivery).toBe('argv')
    expect(result.ok && result.commandLabel).toBe("codex 'Fix checks'")
    expect(result.ok && result.summary).toContain('included in the launch command')
    expect(result.ok && result.caveat).toContain('PATH')
  })

  it('says a typed input past the argv ceiling goes in a private file, and an AI button pastes it', () => {
    const plan = (promptDelivery: 'submit-after-ready' | 'auto-submit') =>
      planSourceControlAgentActionLaunch({
        agent: 'codex',
        commandInput: 'z'.repeat(200_000),
        promptDelivery,
        detectedAgents: ['codex'],
        platform: 'linux'
      })

    const typed = plan('auto-submit')
    expect(typed.ok && typed.summary).toContain('private file')
    expect(typed.ok && typed.summary).not.toContain('included in the launch command')
    const button = plan('submit-after-ready')
    expect(button.ok && button.delivery).toBe('paste-submit')
  })

  it('carries a 20 KB AI-button input on the command line of a POSIX host', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'codex',
      commandInput: 'z'.repeat(20_000),
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['codex'],
      platform: 'darwin'
    })

    expect(result.ok && result.delivery).toBe('argv')
  })

  // Why: main pastes an AI button's prompt on Windows, so the agent's history shows the user's
  // text; only a typed prompt the line would damage rides a launch file.
  it('pastes a multi-line AI-button prompt on Windows, and files the same prompt typed', () => {
    const plan = (promptDelivery: 'submit-after-ready' | 'auto-submit') =>
      planSourceControlAgentActionLaunch({
        agent: 'claude',
        commandInput: 'Fix the failing checks.\nThen push.',
        promptDelivery,
        detectedAgents: ['claude'],
        platform: 'win32',
        terminalWindowsShell: 'cmd.exe'
      })

    const button = plan('submit-after-ready')
    expect(button.ok && button.delivery).toBe('paste-submit')
    expect(button.ok && button.plan.launchCommand).not.toContain('task-context')
    const typed = plan('auto-submit')
    expect(typed.ok && typed.summary).toContain('private file')
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

    expect(result.ok && result.commandLabel).toBe("codex '--model' 'gpt-5.5' 'Fix checks'")
  })

  it('still pastes and submits for an agent that takes its text only after start', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'amp',
      commandInput: 'Fix checks',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['amp'],
      platform: 'linux'
    })

    expect(result.ok && result.delivery).toBe('paste-submit')
    expect(result.ok && result.summary).toContain('pastes and submits')
  })

  it.each([
    {
      terminalWindowsShell: 'cmd.exe',
      expectedCommand: 'powershell.exe -NoProfile -EncodedCommand'
    },
    {
      terminalWindowsShell: 'git-bash',
      expectedCommand: 'ORCA_HERMES_STARTUP_QUERY'
    }
  ])(
    'uses $terminalWindowsShell quoting for Hermes source-control prompts',
    ({ terminalWindowsShell, expectedCommand }) => {
      const result = planSourceControlAgentActionLaunch({
        agent: 'hermes',
        commandInput: 'Review the change',
        promptDelivery: 'auto-submit',
        detectedAgents: ['hermes'],
        platform: 'win32',
        terminalWindowsShell
      })

      expect(result.ok && result.plan.launchCommand).toContain(expectedCommand)
      expect(result.ok && result.plan.env?.ORCA_HERMES_STARTUP_QUERY).toBe('Review the change')
    }
  )

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
