import { describe, expect, it } from 'vitest'
import { resolveAgentSessionOptionLaunch } from '../../agent-session/options/launch/agent-session-option-launch'
import { checkAgentLaunchModelPreferences } from './agent-launch-model-preferences'

describe('checkAgentLaunchModelPreferences (mistral-vibe)', () => {
  it('accepts a Vibe model alias with optional thinking effort and emits --model/--thinking', () => {
    const model = 'mistral-large-4'

    expect(checkAgentLaunchModelPreferences({ agent: 'mistral-vibe', model })).toEqual({
      preferences: { model }
    })
    expect(resolveAgentSessionOptionLaunch('mistral-vibe', { model }, [], false).args).toEqual([
      '--model',
      model
    ])

    const withEffort = { model, effort: 'high' }
    expect(checkAgentLaunchModelPreferences({ agent: 'mistral-vibe', ...withEffort })).toEqual({
      preferences: withEffort
    })
    expect(resolveAgentSessionOptionLaunch('mistral-vibe', withEffort, [], false).args).toEqual([
      '--model',
      model,
      '--thinking',
      'high'
    ])
  })

  it('refuses unsupported Vibe thinking levels and --effort without --model', () => {
    expect(
      checkAgentLaunchModelPreferences({
        agent: 'mistral-vibe',
        model: 'mistral-large-4',
        effort: 'minimal'
      })
    ).toEqual({
      refusal: {
        code: 'invalid_argument',
        message: 'Agent mistral-vibe model mistral-large-4 does not support effort minimal.'
      }
    })

    expect(
      checkAgentLaunchModelPreferences({
        agent: 'mistral-vibe',
        effort: 'high'
      })
    ).toEqual({
      refusal: {
        code: 'invalid_argument',
        message: '--effort requires --model.'
      }
    })
  })
})
