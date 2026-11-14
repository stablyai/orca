import { describe, expect, it } from 'vitest'
import { resolveAgentSessionOptionLaunch } from '../../agent-session/options/agent-session-option-launch'
import { checkAgentLaunchModelPreferences } from './agent-launch-model-preferences'

describe('checkAgentLaunchModelPreferences', () => {
  it('lets Pi launch on a chosen model and thinking level', () => {
    const preferences = { model: 'deepseek/deepseek-flash', effort: 'xhigh' }

    expect(checkAgentLaunchModelPreferences({ agent: 'pi', ...preferences })).toEqual({
      preferences
    })
    expect(resolveAgentSessionOptionLaunch('pi', preferences, [], false).args).toEqual([
      '--model',
      'deepseek/deepseek-flash',
      '--thinking',
      'xhigh'
    ])
  })

  it('refuses a Pi model without a provider, which Pi chats cannot apply', () => {
    for (const model of ['sonnet', '/sonnet', 'anthropic/']) {
      expect(checkAgentLaunchModelPreferences({ agent: 'pi', model })).toMatchObject({
        refusal: { code: 'invalid_argument' }
      })
    }
  })
})
