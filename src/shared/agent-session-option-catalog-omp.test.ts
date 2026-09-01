import { describe, expect, it } from 'vitest'
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
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'deepseek' },
      { id: 'minimax-cn/MiniMax-M3', label: 'MiniMax M3', description: 'minimax-cn' },
      { id: 'openai/gpt-5.5', label: 'Openai GPT 5.5', description: 'openai' }
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
    expect(listModels.parse(LISTING)).toEqual([
      {
        id: 'deepseek/deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        description: 'deepseek',
        options: []
      },
      { id: 'minimax-cn/MiniMax-M3', label: 'MiniMax M3', description: 'minimax-cn', options: [] },
      { id: 'openai/gpt-5.5', label: 'Openai GPT 5.5', description: 'openai', options: [] }
    ])
  })

  it('launches a picked model with --model <selector>', () => {
    expect(resolveAgentSessionOptionLaunch('omp', { model: 'deepseek/deepseek-v4-pro' })).toEqual({
      args: ['--model', 'deepseek/deepseek-v4-pro'],
      appliedValues: { model: 'deepseek/deepseek-v4-pro' }
    })
    expect(resolveAgentSessionOptionLaunch('omp', {})).toEqual({ args: [], appliedValues: {} })
  })

  it('yields to a user --model in the launch args, in either spelling', () => {
    const override = OMP_SESSION_OPTION_CATALOG.modelApply.agentArgsOverride!
    expect(override(['--model', 'opus'])).toBe(true)
    expect(override(['--model=openai/gpt-5.5'])).toBe(true)
    expect(override(['--no-extensions'])).toBe(false)
    // `--models` scopes Ctrl+P cycling; it does not pick a model. omp has no `-m`.
    expect(override(['--models=anthropic/*'])).toBe(false)
    expect(override(['-m', 'opus'])).toBe(false)
  })

  it('switches mid-session with /model <selector>, which omp resolves exactly', () => {
    const midSession = OMP_SESSION_OPTION_CATALOG.modelApply.midSession
    expect(midSession).toMatchObject({ kind: 'command' })
    if (midSession?.kind !== 'command') {
      throw new Error('expected a command apply')
    }
    const command = midSession.build('minimax-cn/MiniMax-M3')
    expect(command).toBe('/model minimax-cn/MiniMax-M3')
    expect(parseBuiltSessionOptionCommand(midSession.build, command)).toBe('minimax-cn/MiniMax-M3')
    expect(parseBuiltSessionOptionCommand(midSession.build, '/model ')).toBeNull()
  })
})
