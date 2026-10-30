import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'

describe('Pi launch options', () => {
  it('does not expose worker-only launch options as an interactive session catalog', () => {
    expect(getAgentSessionOptionCatalog('pi')).toBeNull()
  })

  it('maps the model to --model and the effort to --thinking', () => {
    expect(
      resolveAgentSessionOptionLaunch('pi', {
        model: 'openai-codex/gpt-6.1-terra',
        effort: 'xhigh'
      })
    ).toEqual({
      args: ['--model', 'openai-codex/gpt-6.1-terra', '--thinking', 'xhigh'],
      appliedValues: { model: 'openai-codex/gpt-6.1-terra', effort: 'xhigh' }
    })
  })

  it('replaces configured --model and --thinking arguments in either spelling', () => {
    expect(
      removeOverriddenAgentSessionArgs(
        'pi',
        { model: 'openai-codex/gpt-6.1-terra', effort: 'low' },
        ['--model', 'anthropic/opus', '--thinking=high', '--no-extensions']
      )
    ).toEqual(['--no-extensions'])
  })
})
