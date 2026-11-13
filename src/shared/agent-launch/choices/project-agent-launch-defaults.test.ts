import { describe, expect, it } from 'vitest'
import {
  applyProjectAgentLaunchDefaults,
  normalizeProjectAgentLaunchDefaults
} from './project-agent-launch-defaults'
import { structuredLaunchSeedOptions } from '../../native-chat/input/native-chat-session-option-defaults'
import { resolveAgentChoiceLayers } from './agent-choice-layers'

const global = {
  defaultTuiAgent: 'claude' as const,
  agentLaunchChoices: { codex: { model: 'gpt-5.4', options: { effort: 'high' } } },
  agentPermissionDefault: 'own' as const
}

describe('project launch defaults', () => {
  it('inherits global settings until overridden and resumes inheritance when cleared', () => {
    expect(applyProjectAgentLaunchDefaults(global, undefined)).toBe(global)
    const settings = applyProjectAgentLaunchDefaults(global, {
      defaultTuiAgent: 'codex',
      agentLaunchChoices: { codex: { model: 'gpt-5.3-codex', options: { effort: 'medium' } } }
    })
    expect(settings.defaultTuiAgent).toBe('codex')
    expect(structuredLaunchSeedOptions(settings, 'codex')).toMatchObject({
      model: 'gpt-5.3-codex',
      effort: 'medium',
      permissionMode: 'own'
    })
    expect(global.agentLaunchChoices.codex).toEqual({
      model: 'gpt-5.4',
      options: { effort: 'high' }
    })
    expect(applyProjectAgentLaunchDefaults(global, undefined).defaultTuiAgent).toBe('claude')
  })

  it('does not carry global effort into a different project model', () => {
    const settings = applyProjectAgentLaunchDefaults(global, {
      agentLaunchChoices: { codex: { model: 'gpt-5.3-codex' } }
    })
    expect(settings.agentLaunchChoices?.codex).toEqual({ model: 'gpt-5.3-codex' })
    expect(
      resolveAgentChoiceLayers({
        agent: 'codex',
        argumentOwner: 'defaults',
        defaults: settings.agentLaunchChoices?.codex,
        explicit: { model: 'gpt-5.4', options: { effort: 'low' } }
      })
    ).toEqual({ model: 'gpt-5.4', options: { effort: 'low' } })
  })

  it('drops invalid stored agents and permission overrides', () => {
    expect(
      normalizeProjectAgentLaunchDefaults({
        defaultTuiAgent: 'bogus',
        agentLaunchChoices: { bogus: { model: 'wrong' } },
        agentPermissionDefault: 'yolo'
      })
    ).toBeUndefined()
    expect(
      normalizeProjectAgentLaunchDefaults({
        agentLaunchChoices: { codex: { model: 'gpt-5.4', permissionMode: 'yolo' } }
      })
    ).toEqual({ agentLaunchChoices: { codex: { model: 'gpt-5.4' } } })
  })
})
