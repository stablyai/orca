import { describe, expect, it } from 'vitest'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  resolveBaseCommand
} from './tui-agent-startup'
import { isExpectedAgentProcess } from './agent-process-recognition'

describe('tui agent startup plans for custom agents', () => {
  it('fails gracefully instead of indexing TUI_AGENT_CONFIG for an orphaned custom agent id', () => {
    const result = resolveBaseCommand({
      agent: 'custom:ghost',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      customAgents: []
    })

    expect(result).toEqual({ ok: false, error: 'Unknown custom agent: custom:ghost' })
  })

  it('resolves the custom agent command for a known custom agent id', () => {
    const result = resolveBaseCommand({
      agent: 'custom:my-agent',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      customAgents: [
        {
          id: 'custom:my-agent',
          name: 'My Agent',
          command: '/usr/local/bin/my-agent',
          promptMode: 'pty',
          icon: { kind: 'terminal' },
          enabled: true
        }
      ]
    })

    expect(result).toEqual({ ok: true, command: '/usr/local/bin/my-agent' })
  })

  it('does not build a startup plan for an orphaned custom agent id', () => {
    const plan = buildAgentStartupPlan({
      agent: 'custom:ghost',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: {},
      platform: 'linux',
      customAgents: []
    })

    expect(plan).toBeNull()
  })

  it('derives expectedProcess from the custom agent binary, not the custom:* id', () => {
    const plan = buildAgentStartupPlan({
      agent: 'custom:my-agent',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: {},
      platform: 'linux',
      customAgents: [
        {
          id: 'custom:my-agent',
          name: 'My Agent',
          command: '/usr/local/bin/my-agent --flag',
          promptMode: 'pty',
          icon: { kind: 'terminal' },
          enabled: true
        }
      ]
    })

    expect(plan?.expectedProcess).toBe('my-agent')
    expect(isExpectedAgentProcess('my-agent', plan?.expectedProcess ?? '')).toBe(true)
    expect(isExpectedAgentProcess('custom:my-agent', plan?.expectedProcess ?? '')).toBe(false)
  })

  it('falls back to the custom:* id as expectedProcess when the command cannot be parsed', () => {
    const plan = buildAgentStartupPlan({
      agent: 'custom:my-agent',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: {},
      platform: 'linux',
      customAgents: [
        {
          id: 'custom:my-agent',
          name: 'My Agent',
          command: '',
          promptMode: 'pty',
          icon: { kind: 'terminal' },
          enabled: true
        }
      ]
    })

    expect(plan?.expectedProcess).toBe('custom:my-agent')
  })

  it('keeps buildAgentDraftLaunchPlan consistent with buildAgentStartupPlan for expectedProcess', () => {
    const customAgents = [
      {
        id: 'custom:my-agent' as const,
        name: 'My Agent',
        command: '/usr/local/bin/my-agent',
        promptMode: 'pty' as const,
        icon: { kind: 'terminal' as const },
        enabled: true
      }
    ]
    const startupPlan = buildAgentStartupPlan({
      agent: 'custom:my-agent',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: {},
      platform: 'linux',
      customAgents
    })

    // Why: custom agents never set draftPromptFlag/draftPromptEnvVar, so the
    // draft plan always no-ops to null — callers fall back to the empty-launch
    // + post-ready paste path. Assert that fallback rather than a draft plan.
    const draftPlan = buildAgentDraftLaunchPlan({
      agent: 'custom:my-agent',
      draft: 'hello',
      cmdOverrides: {},
      platform: 'linux',
      customAgents
    })

    expect(draftPlan).toBeNull()
    expect(startupPlan?.expectedProcess).toBe('my-agent')
  })
})
