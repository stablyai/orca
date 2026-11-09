import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { agentArgTerminatorIndex } from './agent-session-option-agent-args'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'

const removeCodexModel = getAgentSessionOptionCatalog('codex')!.modelApply.removeAgentArgs!

describe('catalog removers', () => {
  it.each([
    [['-c', 'model=o3']],
    [['--config', 'model=o3']],
    [['-c=model=o3']],
    [['-cmodel=o3']],
    [['--config=model=o3']]
  ])('strips Codex model config %j and yields the picked model to it', (tokens) => {
    expect(removeCodexModel([...tokens, '--search'])).toEqual(['--search'])
    expect(
      resolveAgentSessionOptionLaunch('codex', { model: 'gpt-5.5' }, tokens).appliedValues
    ).toEqual({})
  })

  it('keeps other Codex config, including effort, when stripping the model', () => {
    const tokens = [
      '-c',
      'model_reasoning_effort=high',
      '-cmodel_reasoning_effort=low',
      '-csandbox=x'
    ]
    expect(removeCodexModel(tokens)).toEqual(tokens)
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
