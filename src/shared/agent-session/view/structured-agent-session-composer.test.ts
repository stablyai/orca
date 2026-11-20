import { describe, expect, it, vi } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  type StructuredAgentSessionComposerOptions
} from './structured-agent-session-composer'

describe('dispatchStructuredAgentSessionComposerCommand', () => {
  it('applies /model by a Claude row label with or without the vendor, only for Claude', async () => {
    const setOption = vi.fn(async () => true)
    const controller: StructuredAgentSessionComposerOptions = {
      agent: 'claude',
      snapshot: [
        {
          id: 'model',
          label: 'Model',
          category: 'model',
          kind: {
            type: 'select',
            currentValue: 'claude-haiku-5-5',
            choices: [
              { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
              { value: 'claude-opus-5-5', label: 'Opus 5.5' }
            ]
          },
          valueSource: 'default',
          transport: 'agent-session',
          settable: true
        }
      ],
      setOption,
      invokeAction: async () => false
    }
    await dispatchStructuredAgentSessionComposerCommand('/model Claude Opus 5.5', controller)
    await dispatchStructuredAgentSessionComposerCommand('/model opus 5.5', controller)
    await dispatchStructuredAgentSessionComposerCommand('/model Claude Opus 5.5', {
      ...controller,
      agent: 'cursor'
    })
    expect(setOption.mock.calls).toEqual([
      ['model', 'claude-opus-5-5'],
      ['model', 'claude-opus-5-5'],
      ['model', 'Claude Opus 5.5']
    ])
  })
})
