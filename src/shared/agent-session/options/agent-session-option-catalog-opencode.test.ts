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

  it('keeps arguments after the terminator while removing every earlier model choice', () => {
    expect(
      removeOverriddenAgentSessionArgs('opencode', { model: 'private-proof/model-b' }, [
        '-mfirst',
        '--model=second',
        '--log-level',
        'DEBUG',
        '--',
        '--model',
        'trailing'
      ])
    ).toEqual(['--log-level', 'DEBUG', '--', '--model', 'trailing'])
  })

  it('does not send or record the selected model when free-form arguments override it', () => {
    expect(
      resolveAgentSessionOptionLaunch('opencode', { model: 'private-proof/model-b' }, [
        '-m',
        'private-proof/model-a'
      ])
    ).toEqual({ args: [], appliedValues: {} })
  })

  it('records the selected model when model-like arguments follow the terminator', () => {
    expect(
      resolveAgentSessionOptionLaunch('opencode', { model: 'private-proof/model-b' }, [
        '--',
        '--model',
        'private-proof/model-a'
      ])
    ).toEqual({
      args: ['--model', 'private-proof/model-b'],
      appliedValues: { model: 'private-proof/model-b' }
    })
  })
})
