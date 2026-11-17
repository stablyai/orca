import { describe, expect, it } from 'vitest'
import { checkAgentLaunchModelPreferences } from '../../../agent-launch/choices/agent-launch-model-preferences'
import { resolveAgentSessionOptionLaunch } from '../launch/agent-session-option-launch'

describe('Kiro launch options', () => {
  it('accepts a model with effort and launches with both flags', () => {
    const check = checkAgentLaunchModelPreferences({
      agent: 'kiro',
      model: 'claude-sonnet-5.5',
      effort: 'high'
    })
    expect(check).toEqual({ preferences: { model: 'claude-sonnet-5.5', effort: 'high' } })
    const { args } = resolveAgentSessionOptionLaunch(
      'kiro',
      { model: 'claude-sonnet-5.5', effort: 'high' },
      [],
      false
    )
    expect(args).toEqual(['--model', 'claude-sonnet-5.5', '--effort', 'high'])
  })

  it('refuses an unknown effort level', () => {
    expect(
      checkAgentLaunchModelPreferences({ agent: 'kiro', model: 'auto', effort: 'ultra' })
    ).toHaveProperty('refusal.message', 'Agent kiro model auto does not support effort ultra.')
  })
})
