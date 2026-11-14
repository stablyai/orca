import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from '../agent-session-option-catalog'
import { agentArgTerminatorIndex } from '../launch/agent-session-option-agent-args'

const removeCodexModel = getAgentSessionOptionCatalog('codex')!.modelApply.removeAgentArgs!

describe('catalog removers', () => {
  it.each([[['-cmodel=o3']]])('strips Codex model config %j', (tokens) => {
    expect(removeCodexModel([...tokens, '--search'])).toEqual(['--search'])
  })
})

describe('removeAgentArgOption', () => {
  it('requires an exact terminator outside option values', () => {
    expect(
      agentArgTerminatorIndex('claude', [
        '--append-system-prompt',
        '--',
        '--=literal',
        '--',
        'text'
      ])
    ).toBe(3)
  })
})
