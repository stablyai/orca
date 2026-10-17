import { describe, expect, it } from 'vitest'
import { checkAgentLaunchModelPreferences } from './agent-launch-model-preferences'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { OMP_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-omp'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { parseBuiltSessionOptionCommand } from './native-chat-session-option-commands'
import { OMP_MODEL_LIST_ARGS, parseOmpModelList } from './omp-model-list-probe'

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
    // A ladder without `high` names the closest tier under OMP's default.
    { provider: 'acme', id: 'no-high', name: 'No High', thinking: ['minimal', 'low', 'medium'] },
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
  it('asks omp for its machine-readable listing', () => {
    expect(OMP_MODEL_LIST_ARGS).toEqual(['models', '--json'])
  })

  it('parses selectors as ids, names as labels, and providers as descriptions', () => {
    expect(parseOmpModelList(LISTING)).toEqual([
      {
        id: 'deepseek/deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        description: 'deepseek',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' },
          { id: 'max', label: 'Max' }
        ]
      },
      { id: 'minimax-cn/MiniMax-M3', label: 'MiniMax M3', description: 'minimax-cn' },
      {
        id: 'acme/no-high',
        label: 'No High',
        description: 'acme',
        thinkingLevels: [
          { id: 'minimal', label: 'Minimal' },
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' }
        ]
      },
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
      'acme/no-high',
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
  it('is registered for the omp agent', () => {
    expect(getAgentSessionOptionCatalog('omp')).toBe(OMP_SESSION_OPTION_CATALOG)
  })

  it('seeds no model because none is available on every install', () => {
    expect(OMP_SESSION_OPTION_CATALOG.models).toEqual([])
    expect(OMP_SESSION_OPTION_CATALOG.defaultModelIsCliDefault).toBeUndefined()
    expect(OMP_SESSION_OPTION_CATALOG.discoveredModelsAreAuthoritative).toBe(true)
  })

  it('discovers models through the same JSON listing the probe parses', () => {
    const listModels = OMP_SESSION_OPTION_CATALOG.listModels!
    expect(listModels.command).toBe('omp models --json')
    const parsed = listModels.parse(LISTING)
    const effortOf = (id: string) => {
      const row = parsed.find((candidate) => candidate.id === id)!
      return row.options.flatMap((option) =>
        option.kind.type === 'select'
          ? [
              {
                id: option.id,
                choices: option.kind.choices.map((choice) => choice.value),
                defaultValue: option.kind.defaultValue
              }
            ]
          : []
      )
    }
    // A listed ladder becomes that model's own launch menu; a row without one stays bare.
    // A listed model's menu starts where OMP itself would start: `high`, or the closest
    // lower tier it lists, so picking a model never changes the effort OMP runs.
    expect(effortOf('deepseek/deepseek-v4-pro')).toEqual([
      { id: 'effort', choices: ['low', 'high', 'max'], defaultValue: 'high' }
    ])
    expect(effortOf('acme/no-high')).toEqual([
      { id: 'effort', choices: ['minimal', 'low', 'medium'], defaultValue: 'medium' }
    ])
    expect(effortOf('minimax-cn/MiniMax-M3')).toEqual([])
    expect(effortOf('openai/gpt-5.5')).toEqual([])
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

  it('launches a requested effort as --thinking for any discovered model', () => {
    expect(
      resolveAgentSessionOptionLaunch('omp', {
        model: 'minimax-cn/MiniMax-M3',
        effort: 'xhigh'
      })
    ).toEqual({
      args: ['--model', 'minimax-cn/MiniMax-M3', '--thinking', 'xhigh'],
      appliedValues: { model: 'minimax-cn/MiniMax-M3', effort: 'xhigh' }
    })
  })

  it('accepts OMP thinking levels as effort and refuses modes that are not levels', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(
        checkAgentLaunchModelPreferences({ agent: 'omp', model: 'openai/gpt-5.5', effort })
      ).toEqual({ preferences: { model: 'openai/gpt-5.5', effort } })
    }
    for (const effort of ['off', 'auto', 'inherit', 'ultra']) {
      expect(
        checkAgentLaunchModelPreferences({ agent: 'omp', model: 'openai/gpt-5.5', effort })
      ).toMatchObject({ refusal: { code: 'invalid_argument' } })
    }
  })

  it('keeps effort launch-only: omp registered /effort in 18.5.0, past the 17.0.5 floor', () => {
    const effort = OMP_SESSION_OPTION_CATALOG.unknownModelOptions?.find(
      (option) => option.id === 'effort'
    )
    // A structured chat sets effort through the thought_level config option omp advertises;
    // a terminal chat names no version to gate a live command on, so none is offered.
    expect(effort?.apply.midSession).toBeUndefined()
    expect(effort?.apply.launchArgs?.('xhigh')).toEqual(['--thinking', 'xhigh'])
    // A listed model's own ladder is launch-only for the same reason.
    const listed = OMP_SESSION_OPTION_CATALOG.listModels!.parse(LISTING).find(
      (model) => model.id === 'deepseek/deepseek-v4-pro'
    )
    expect(listed?.options[0]?.apply.midSession).toBeUndefined()
    expect(listed?.options[0]?.apply.launchArgs?.('low')).toEqual(['--thinking', 'low'])
  })
})
