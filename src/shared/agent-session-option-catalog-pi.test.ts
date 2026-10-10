import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { PI_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-pi'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { PI_MODEL_LIST_ARGS, parsePiModelList } from './pi-model-list-probe'

// Row shape as `pi --list-models` prints it (pi 1.1.0): whitespace columns, a
// provider header line, `thinking` and `images` answered yes/no.
const LISTING = [
  'provider        model                   context  max-out  thinking  images',
  'github-copilot  gpt-5.4-mini            400K     128K     yes       yes',
  'google          gemini-3-pro            1M       64K      yes       yes',
  'ollama          llama3.1:8b             128K     8K       no        no',
  'google          gemini-3-pro            1M       64K      yes       yes',
  'No models available. Use /login to log into a provider via OAuth or API key.',
  'noise'
].join('\n')

describe('pi model list probe', () => {
  it('asks pi for its table listing', () => {
    expect(PI_MODEL_LIST_ARGS).toEqual(['--list-models'])
  })

  it('parses provider-qualified ids and drops noise and repeats', () => {
    expect(parsePiModelList(LISTING).map(({ id }) => id)).toEqual([
      'github-copilot/gpt-5.4-mini',
      'google/gemini-3-pro',
      'ollama/llama3.1:8b'
    ])
  })

  it('names thinking levels only on rows the listing marks as reasoning', () => {
    const parsed = parsePiModelList(LISTING)
    expect(parsed.find((model) => model.id === 'google/gemini-3-pro')?.thinkingLevels).toHaveLength(
      7
    )
    expect(
      parsed.find((model) => model.id === 'ollama/llama3.1:8b')?.thinkingLevels
    ).toBeUndefined()
  })

  it('returns nothing for output that is not a listing', () => {
    expect(parsePiModelList('')).toEqual([])
    expect(parsePiModelList('pi: command not found')).toEqual([])
    expect(parsePiModelList('provider model context max-out thinking images')).toEqual([])
  })
})

describe('pi session option catalog', () => {
  it('is registered for the pi agent', () => {
    expect(getAgentSessionOptionCatalog('pi')).toBe(PI_SESSION_OPTION_CATALOG)
  })

  it('seeds no model because none is available on every install', () => {
    expect(PI_SESSION_OPTION_CATALOG.models).toEqual([])
    expect(PI_SESSION_OPTION_CATALOG.discoveredModelsAreAuthoritative).toBe(true)
  })

  it('discovers models through the same listing the probe parses', () => {
    const listModels = PI_SESSION_OPTION_CATALOG.listModels!
    expect(listModels.command).toBe('pi --list-models')
    expect(listModels.parse(LISTING)).toEqual([
      {
        id: 'github-copilot/gpt-5.4-mini',
        label: 'Github Copilot GPT 5.4 Mini',
        options: []
      },
      { id: 'google/gemini-3-pro', label: 'Google Gemini 3 Pro', options: [] },
      { id: 'ollama/llama3.1:8b', label: 'Ollama Llama3.1:8b', options: [] }
    ])
  })

  it('launches a picked model with --model and maps effort to --thinking', () => {
    expect(
      resolveAgentSessionOptionLaunch('pi', { model: 'google/gemini-3-pro', effort: 'xhigh' })
    ).toEqual({
      args: ['--model', 'google/gemini-3-pro', '--thinking', 'xhigh'],
      appliedValues: { model: 'google/gemini-3-pro', effort: 'xhigh' }
    })
    expect(resolveAgentSessionOptionLaunch('pi', { model: 'ollama/llama3.1:8b' })).toEqual({
      args: ['--model', 'ollama/llama3.1:8b'],
      appliedValues: { model: 'ollama/llama3.1:8b' }
    })
    expect(resolveAgentSessionOptionLaunch('pi', {})).toEqual({ args: [], appliedValues: {} })
  })

  it('rejects a thinking level Pi does not know', () => {
    expect(
      resolveAgentSessionOptionLaunch('pi', {
        model: 'google/gemini-3-pro',
        effort: 'turbo'
      }).appliedValues.effort
    ).toBeUndefined()
  })

  it('yields to user --model and --thinking in the launch args, in either spelling', () => {
    const modelRemove = PI_SESSION_OPTION_CATALOG.modelApply.removeAgentArgs!
    expect(
      modelRemove(['--model', 'google/gemini-3-pro', '--model=ollama/llama3.1:8b', '--continue'])
    ).toEqual(['--continue'])
    // `--models` scopes Ctrl+P cycling; it does not pick a model.
    expect(modelRemove(['--models', 'anthropic/*', '--continue'])).toEqual([
      '--models',
      'anthropic/*',
      '--continue'
    ])
    const thinking = PI_SESSION_OPTION_CATALOG.unknownModelOptions!.find(
      (option) => option.id === 'effort'
    )!
    expect(thinking.apply.removeAgentArgs!(['--thinking', 'low', '--thinking=max', '-c'])).toEqual([
      '-c'
    ])
  })
})
