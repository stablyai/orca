import { describe, expect, it } from 'vitest'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from '../launch/agent-session-option-launch'

describe('OpenCode launch options', () => {
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
