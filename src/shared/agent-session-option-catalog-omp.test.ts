import { describe, expect, it } from 'vitest'
import { OMP_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-omp'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import { parseBuiltSessionOptionCommand } from './native-chat-session-option-commands'
import { parseOmpModelList } from './omp-model-list-probe'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'

const LISTING = JSON.stringify({
  models: [
    {
      provider: 'deepseek',
      id: 'deepseek-v4-pro',
      selector: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      thinking: ['low', 'high', 'max']
    },
    {
      provider: 'minimax-cn',
      id: 'MiniMax-M3',
      selector: 'minimax-cn/MiniMax-M3',
      name: 'MiniMax M3'
    },
    // A repeat selector is one model, not two rows.
    { provider: 'deepseek', id: 'deepseek-v4-pro', selector: 'deepseek/deepseek-v4-pro' },
    // Older listings without `selector` still name the model by provider + id.
    { provider: 'openai', id: 'gpt-5.5' },
    // Rows that cannot be launched are dropped rather than guessed.
    { provider: 'zai', name: 'No id' },
    'not a row'
  ]
})

describe('omp model list probe', () => {
  it('parses selectors as ids, names as labels, and providers as descriptions', () => {
    expect(
      parseOmpModelList(LISTING).map(({ thinkingLevels: _thinking, ...model }) => model)
    ).toEqual([
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'deepseek' },
      { id: 'minimax-cn/MiniMax-M3', label: 'MiniMax M3', description: 'minimax-cn' },
      { id: 'openai/gpt-5.5', label: 'Openai GPT 5.5', description: 'openai' }
    ])
  })

  it('keeps the context window each row states', () => {
    // Row shape as `omp models --json` prints it (OMP 17.0.5).
    const listing = JSON.stringify({
      models: [
        {
          provider: 'openai-codex',
          id: 'gpt-5.5',
          selector: 'openai-codex/gpt-5.5',
          name: 'GPT-5.5',
          contextWindow: 272000,
          maxTokens: 128000
        },
        { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 1000000 },
        { provider: 'zai', id: 'glm', name: 'GLM', contextWindow: 0 },
        { provider: 'zai', id: 'glm-air', name: 'GLM Air', contextWindow: '128000' }
      ]
    })
    expect(
      parseOmpModelList(listing).map(({ id, contextWindowTokens }) => ({ id, contextWindowTokens }))
    ).toEqual([
      { id: 'openai-codex/gpt-5.5', contextWindowTokens: 272000 },
      { id: 'openai-codex/gpt-5.4', contextWindowTokens: 1000000 },
      { id: 'zai/glm', contextWindowTokens: undefined },
      { id: 'zai/glm-air', contextWindowTokens: undefined }
    ])
  })

  it('tolerates an update notice printed ahead of the JSON', () => {
    const noisy = `Package updates are available. Run omp update\n${LISTING}\n`
    expect(parseOmpModelList(noisy).map(({ id }) => id)).toEqual([
      'deepseek/deepseek-v4-pro',
      'minimax-cn/MiniMax-M3',
      'openai/gpt-5.5'
    ])
  })

  it('ignores malformed JSON rows while keeping valid selectors', () => {
    expect(
      parseOmpModelList(
        JSON.stringify({
          models: [
            null,
            false,
            42,
            [],
            { provider: {}, id: [] },
            { selector: 5 },
            { selector: 'openai/gpt-5.5', name: null, provider: 'openai' }
          ]
        })
      )
    ).toEqual([{ id: 'openai/gpt-5.5', label: 'Openai GPT 5.5', description: 'openai' }])
    for (const value of ['null', 'true', '3', '"text"']) {
      expect(parseOmpModelList(value)).toEqual([])
    }
  })

  it('returns nothing for output that is not a listing', () => {
    expect(parseOmpModelList('')).toEqual([])
    expect(parseOmpModelList('omp: command not found')).toEqual([])
    expect(parseOmpModelList('{"models": "nope"}')).toEqual([])
    expect(parseOmpModelList('[1, 2]')).toEqual([])
  })
})

describe('omp session option catalog', () => {
  it('does not invent OMP thinking choices for a reported model with no advertised metadata', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('omp'),
      { ...OMP_SESSION_OPTION_CATALOG },
      { models: [], current: { model: 'opaque-model', effort: 'high' } }
    )
    expect(state.catalog?.models).toEqual([
      { id: 'opaque-model', label: 'opaque-model', options: [] }
    ])
    expect(
      structuredAgentSessionOptionSnapshot(state).some((descriptor) => descriptor.id === 'effort')
    ).toBe(false)
  })

  it('keeps model-specific native thinking choices without guessing a default', () => {
    const models = parseOmpModelList(LISTING)
    expect(models[0].thinkingLevels?.map(({ id }) => id)).toEqual([
      'off',
      'low',
      'high',
      'max',
      'auto'
    ])
    expect(models[0].defaultThinkingLevel).toBeUndefined()
    expect(models[1].thinkingLevels).toBeUndefined()
    expect(models[2].thinkingLevels).toBeUndefined()
    const options = OMP_SESSION_OPTION_CATALOG.listModels!.parse(LISTING)[0].options
    expect(options[0].kind).toMatchObject({ defaultValue: 'config-default' })
    expect(options[0].apply.midSession).toEqual({ kind: 'unsupported' })
  })

  it('drops malformed, duplicate, and foreign thinking values', () => {
    const model = parseOmpModelList(
      JSON.stringify({
        models: [
          {
            provider: 'custom',
            id: 'model',
            thinking: ['high', 'high', 'ultra', 'turbo', null, 12]
          }
        ]
      })
    )[0]
    expect(model.thinkingLevels?.map(({ id }) => id)).toEqual(['off', 'high', 'auto'])
  })

  it.each([
    { thinking: undefined },
    { thinking: null },
    { thinking: [] },
    { thinking: ['off', 'auto'] },
    { thinking: ['ultra'] },
    { thinking: 'high' }
  ])('does not invent thinking capabilities from $thinking', ({ thinking }) => {
    const listing = JSON.stringify({ models: [{ provider: 'custom', id: 'plain', thinking }] })
    expect(parseOmpModelList(listing)[0].thinkingLevels).toBeUndefined()
    expect(OMP_SESSION_OPTION_CATALOG.listModels!.parse(listing)[0].options).toEqual([])
  })

  it('keeps configured thinking unset and yields to explicit native launch flags', () => {
    const model = 'custom/model'
    expect(
      resolveAgentSessionOptionLaunch('omp', { model, effort: 'config-default' }, [], true)
    ).toEqual({
      args: ['--model', model],
      appliedValues: { model }
    })
    expect(
      resolveAgentSessionOptionLaunch(
        'omp',
        { model, effort: 'high' },
        ['--model=other/model', '--thinking=auto', '--no-extensions'],
        false
      )
    ).toEqual({ args: [], appliedValues: {} })
    expect(
      removeOverriddenAgentSessionArgs('omp', { model, effort: 'config-default' }, [
        '--thinking=high',
        '--no-extensions',
        '--',
        '--thinking',
        'low'
      ])
    ).toEqual(['--thinking=high', '--no-extensions', '--', '--thinking', 'low'])
  })

  it.each([undefined, 'config-default'])(
    'preserves user-authored thinking arguments without an explicit override: %s',
    (effort) => {
      const tokens = ['--thinking=auto', '--no-extensions', '--', '--thinking', 'low']
      const values = { model: 'provider/model:high', ...(effort ? { effort } : {}) }
      expect(removeOverriddenAgentSessionArgs('omp', values, tokens)).toEqual(tokens)
      expect(resolveAgentSessionOptionLaunch('omp', values, tokens, false)).toEqual({
        args: ['--model', values.model],
        appliedValues: { model: values.model }
      })
    }
  )

  it.each(['off', 'auto'])('passes explicit %s unchanged for native validation', (effort) => {
    const picks = { model: 'provider/model:high', effort }
    const tokens = ['--thinking=low', '--no-extensions']
    const remaining = removeOverriddenAgentSessionArgs('omp', picks, tokens)
    expect(remaining).toEqual(['--no-extensions'])
    expect(resolveAgentSessionOptionLaunch('omp', picks, remaining, false)).toEqual({
      args: ['--model', picks.model, '--thinking', effort],
      appliedValues: picks
    })
  })

  it('launches native thinking and removes conflicting free-form flags for explicit picks', () => {
    const picks = { model: 'deepseek/deepseek-v4-pro', effort: 'max' }
    expect(resolveAgentSessionOptionLaunch('omp', picks, [], false)).toEqual({
      args: ['--model', picks.model, '--thinking', 'max'],
      appliedValues: picks
    })
    const args = ['--thinking', 'low', '--thinking=auto', '--no-extensions']
    expect(removeOverriddenAgentSessionArgs('omp', picks, args)).toEqual(['--no-extensions'])
    expect(resolveAgentSessionOptionLaunch('omp', picks, args, false)).toEqual({
      args: ['--model', picks.model],
      appliedValues: { model: picks.model }
    })
    // Launch sees every selector as opaque; only native thinking levels may pass to OMP.
    expect(
      resolveAgentSessionOptionLaunch('omp', { ...picks, effort: 'ultra' }, [], false)
    ).toEqual({
      args: ['--model', picks.model],
      appliedValues: { model: picks.model }
    })
  })

  it('launches a picked model with --model <selector>', () => {
    expect(resolveAgentSessionOptionLaunch('omp', { model: 'deepseek/deepseek-v4-pro' })).toEqual({
      args: ['--model', 'deepseek/deepseek-v4-pro'],
      appliedValues: { model: 'deepseek/deepseek-v4-pro' }
    })
    expect(resolveAgentSessionOptionLaunch('omp', {})).toEqual({ args: [], appliedValues: {} })
  })

  it('yields to a user --model in the launch args, in either spelling', () => {
    const remove = OMP_SESSION_OPTION_CATALOG.modelApply.removeAgentArgs!
    expect(remove(['--model', 'opus', '--model=openai/gpt-5.5', '--no-extensions'])).toEqual([
      '--no-extensions'
    ])
    // `--models` scopes Ctrl+P cycling; it does not pick a model. omp has no `-m`.
    expect(remove(['--models=anthropic/*', '-m', 'opus'])).toEqual([
      '--models=anthropic/*',
      '-m',
      'opus'
    ])
  })

  it('switches mid-session with /orca-model <selector>, which omp resolves exactly', () => {
    const midSession = OMP_SESSION_OPTION_CATALOG.modelApply.midSession
    expect(midSession).toMatchObject({ kind: 'command' })
    if (midSession?.kind !== 'command') {
      throw new Error('expected a command apply')
    }
    const command = midSession.build('minimax-cn/MiniMax-M3')
    expect(command).toBe('/orca-model minimax-cn/MiniMax-M3')
    expect(parseBuiltSessionOptionCommand(midSession.build, command)).toBe('minimax-cn/MiniMax-M3')
    expect(parseBuiltSessionOptionCommand(midSession.build, '/orca-model ')).toBeNull()
  })
})
