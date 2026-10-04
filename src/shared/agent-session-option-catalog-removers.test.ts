import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'

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

  it('leaves everything after a terminator', () => {
    const tokens = ['--', '-c', 'model=o3']
    expect(removeCodexModel(tokens)).toEqual(tokens)
  })

  it('lets a chat pick replace a configured gemini model on server launches', () => {
    expect(
      removeOverriddenAgentSessionArgs('gemini', { model: 'gemini-2.5-pro' }, [
        '-m',
        'a',
        '--model=b',
        '-mc',
        '--yolo'
      ])
    ).toEqual(['--yolo'])
  })
})

describe('removeAgentArgOption', () => {
  it('consumes an empty value', () => {
    expect(removeAgentArgOption(['--model', '', '--yolo'], ['--model'])).toEqual(['--yolo'])
  })

  it('keeps a following flag', () => {
    expect(removeAgentArgOption(['--model', '--yolo'], ['--model'])).toEqual(['--yolo'])
  })
})
