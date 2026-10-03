import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'

describe('OpenCode launch options', () => {
  it('does not expose worker-only launch options as an interactive session catalog', () => {
    expect(getAgentSessionOptionCatalog('opencode')).toBeNull()
  })

  it('maps an opaque model id to the OpenCode --model flag', () => {
    expect(
      resolveAgentSessionOptionLaunch('opencode', {
        model: 'zai-coding-plan/glm-5.3-flash'
      })
    ).toEqual({
      args: ['--model', 'zai-coding-plan/glm-5.3-flash'],
      appliedValues: { model: 'zai-coding-plan/glm-5.3-flash' }
    })
  })

  it('removes a configured model flag before applying a per-launch model', () => {
    expect(
      removeOverriddenAgentSessionArgs('opencode', { model: 'zai-coding-plan/glm-5.3-flash' }, [
        '--model',
        'opencode/global-default',
        '--log-level',
        'DEBUG'
      ])
    ).toEqual(['--log-level', 'DEBUG'])
  })
})
