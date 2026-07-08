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
    ).toEqual({
      ok: false,
      error: 'The selected agent is disabled in Settings.'
    })
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
    ).toEqual({
      ok: false,
      error: 'The selected agent was not detected on this workspace host.'
    })
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

  it('accepts profiles when their base agent is detected', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'agent-profile:claude-foo',
      commandInput: 'Fix checks',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['claude'],
      agentProfiles: [
        {
          id: 'agent-profile:claude-foo',
          baseAgent: 'claude',
          label: 'Claude (foo)',
          defaultArgs: '--foo'
        }
      ],
      platform: 'darwin'
    })

    expect(result.ok && result.delivery).toBe('paste-submit')
    expect(result.ok && result.commandLabel).toBe('claude')
  })

  it('returns a clear error when a profile id no longer resolves', () => {
    expect(
      planSourceControlAgentActionLaunch({
        agent: 'agent-profile:deleted',
        commandInput: 'Fix checks',
        promptDelivery: 'submit-after-ready',
        detectedAgents: ['agent-profile:deleted'],
        agentProfiles: [],
        platform: 'darwin'
      })
    ).toEqual({
      ok: false,
      error: 'Could not resolve the selected agent profile.'
    })
  })
})
