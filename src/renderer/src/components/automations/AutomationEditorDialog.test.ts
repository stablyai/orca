import { describe, expect, it } from 'vitest'
import { getVisibleAutomationAgents } from './AutomationEditorDialog'

describe('getVisibleAutomationAgents', () => {
  it('shows profile agents directly under their base agent', () => {
    const agents = getVisibleAutomationAgents({
      agentProfiles: [
        {
          id: 'agent-profile:claude-foo',
          baseAgent: 'claude',
          label: 'Claude (foo)',
          defaultArgs: '--foo',
          defaultEnv: {}
        }
      ],
      disabledTuiAgents: [],
      selectedAgent: 'claude'
    }).map((agent) => agent.id)

    expect(agents.slice(agents.indexOf('claude'), agents.indexOf('claude') + 2)).toEqual([
      'claude',
      'agent-profile:claude-foo'
    ])
  })

  it('filters disabled profiles unless they are already selected', () => {
    const profiles = [
      {
        id: 'agent-profile:codex-mini',
        baseAgent: 'codex',
        label: 'Codex Mini',
        defaultArgs: '--model mini',
        defaultEnv: {}
      }
    ] as const

    expect(
      getVisibleAutomationAgents({
        agentProfiles: profiles,
        disabledTuiAgents: ['agent-profile:codex-mini'],
        selectedAgent: 'codex'
      }).map((agent) => agent.id)
    ).not.toContain('agent-profile:codex-mini')

    expect(
      getVisibleAutomationAgents({
        agentProfiles: profiles,
        disabledTuiAgents: ['agent-profile:codex-mini'],
        selectedAgent: 'agent-profile:codex-mini'
      }).map((agent) => agent.id)
    ).toContain('agent-profile:codex-mini')
  })
})
