import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog, mergeCatalogModels } from './agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import {
  resolveNativeChatSessionOptionDefaults,
  updateNativeChatSessionOptionDefaults
} from './native-chat-session-option-defaults'

describe('agent session option catalog', () => {
  it('returns no catalog for unknown agents', () => {
    expect(getAgentSessionOptionCatalog('future-agent')).toBeNull()
  })

  it('keeps Claude option sets model-scoped', () => {
    const catalog = getAgentSessionOptionCatalog('claude')
    expect(
      catalog?.models.find((model) => model.id === 'opus')?.options.map(({ id }) => id)
    ).toEqual(['effort', 'fastMode'])
    expect(catalog?.models.find((model) => model.id === 'haiku')?.options).toEqual([])
  })

  it('merges discovered labels while preserving cataloged option shapes', () => {
    const seed = getAgentSessionOptionCatalog('cursor')!.models
    const merged = mergeCatalogModels(seed, [
      { id: 'gpt-5.3-codex', label: 'GPT 5.3 (live)', options: [] },
      { id: 'new-account-model', label: 'new-account-model', options: [] }
    ])
    expect(merged.find((model) => model.id === 'gpt-5.3-codex')).toMatchObject({
      label: 'GPT 5.3 (live)',
      options: expect.arrayContaining([expect.objectContaining({ id: 'effort' })])
    })
    expect(merged.at(-1)).toEqual({
      id: 'new-account-model',
      label: 'new-account-model',
      options: []
    })
  })

  it('labels Claude seed models by alias family so no host is mislabeled', () => {
    const catalog = getAgentSessionOptionCatalog('claude')!
    expect(catalog.models.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'fable', label: 'Fable' },
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' }
    ])
    expect(catalog.models.find((model) => model.isDefault)?.id).toBe('sonnet')
  })

  it('parses Claude list_models discovery into catalog models with options', () => {
    const stdout = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        response: {
          models: [
            {
              value: 'default',
              displayName: 'Default (recommended)',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsFastMode: true
            },
            {
              value: 'opus[1m]',
              displayName: 'Opus (1M context)',
              description: 'Opus 5 with 1M context',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsFastMode: true
            },
            {
              value: 'sonnet',
              displayName: 'Sonnet',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high']
            },
            { value: 'haiku', displayName: 'Haiku' }
          ]
        }
      }
    })
    const parsed = getAgentSessionOptionCatalog('claude')!.listModels!.parse(stdout)
    expect(parsed.map(({ id }) => id)).toEqual(['opus[1m]', 'sonnet', 'haiku'])
    expect(parsed[0]).toMatchObject({
      label: 'Opus (1M context)',
      description: 'Opus 5 with 1M context'
    })
    expect(parsed[0].options.map(({ id }) => id)).toEqual(['effort', 'fastMode'])
    const opusEffort = parsed[0].options[0]
    expect(opusEffort.kind).toMatchObject({ defaultValue: 'high' })
    expect(
      opusEffort.kind.type === 'select' ? opusEffort.kind.choices.map((c) => c.value) : []
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    const sonnetEffort = parsed[1].options[0]
    expect(
      sonnetEffort.kind.type === 'select' ? sonnetEffort.kind.choices.map((c) => c.value) : []
    ).toEqual(['low', 'medium', 'high'])
    expect(parsed[2].options).toEqual([])
  })

  it('seeds Codex effort menus from advertised ceilings, not a shared cap', () => {
    const catalog = getAgentSessionOptionCatalog('codex')!
    const effortValues = (modelId: string): string[] => {
      const option = catalog.models
        .find((model) => model.id === modelId)
        ?.options.find((candidate) => candidate.id === 'effort')
      return option?.kind.type === 'select' ? option.kind.choices.map(({ value }) => value) : []
    }

    expect(catalog.models.map(({ id }) => id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark'
    ])
    expect(effortValues('gpt-5.6-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(effortValues('gpt-5.6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortValues('gpt-5.5')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(catalog.models.flatMap((model) => effortValues(model.id))).not.toContain('minimal')
    expect(catalog.models.some((model) => model.id === 'gpt-5.2-codex')).toBe(false)
    expect(catalog.models.some((model) => model.id === 'luna')).toBe(false)
  })

  it('parses Codex discovery into model-specific reasoning options', () => {
    const catalog = getAgentSessionOptionCatalog('codex')!
    expect(catalog.listModels?.command).toBe('codex debug models')
    expect(catalog.discoveredModelsAreAuthoritative).toBe(true)

    const parsed = catalog.listModels!.parse(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-5.6-sol',
            display_name: 'GPT-5.6-Sol',
            default_reasoning_level: 'low',
            visibility: 'list',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'high' },
              { effort: 'max' },
              { effort: 'ultra' }
            ]
          },
          {
            slug: 'gpt-5.6-luna',
            display_name: 'GPT-5.6-Luna',
            default_reasoning_level: 'medium',
            visibility: 'list',
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }]
          },
          {
            slug: 'gpt-5.5',
            display_name: 'GPT-5.5',
            visibility: 'list',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'medium' },
              { effort: 'high' },
              { effort: 'xhigh' }
            ]
          },
          {
            slug: 'codex-auto-review',
            display_name: 'Codex Auto Review',
            visibility: 'hide',
            supported_reasoning_levels: [{ effort: 'max' }]
          }
        ]
      })
    )

    expect(parsed.map(({ id }) => id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5'])
    expect(
      parsed[0].options[0].kind.type === 'select'
        ? parsed[0].options[0].kind.choices.map(({ value }) => value)
        : []
    ).toEqual(['low', 'high', 'max', 'ultra'])
    expect(parsed[0].options[0].kind).toMatchObject({ defaultValue: 'low' })
    expect(
      parsed[1].options[0].kind.type === 'select'
        ? parsed[1].options[0].kind.choices.map(({ value }) => value)
        : []
    ).toEqual(['low', 'max'])
    expect(
      parsed[2].options[0].kind.type === 'select'
        ? parsed[2].options[0].kind.choices.map(({ value }) => value)
        : []
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('keeps the Codex seed when model discovery output is malformed', () => {
    const parse = getAgentSessionOptionCatalog('codex')!.listModels!.parse
    expect(parse('')).toEqual([])
    expect(parse('{"models":false}')).toEqual([])
    expect(parse('garbage')).toEqual([])
  })

  it('deduplicates Codex models and reasoning levels from discovery', () => {
    const parse = getAgentSessionOptionCatalog('codex')!.listModels!.parse
    const parsed = parse(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-account-frontier',
            display_name: 'GPT Account Frontier',
            visibility: 'list',
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'low' }, { effort: 'high' }]
          },
          { slug: 'gpt-account-frontier', display_name: 'Duplicate row', visibility: 'list' }
        ]
      })
    )

    expect(parsed).toHaveLength(1)
    expect(parsed[0].label).toBe('GPT Account Frontier')
    expect(parsed[0].options[0].kind).toMatchObject({
      choices: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ],
      defaultValue: 'low'
    })
  })

  it('keeps the Claude seed when list_models output is unsupported or malformed', () => {
    const parse = getAgentSessionOptionCatalog('claude')!.listModels!.parse
    const unsupported =
      '{"type":"control_response","response":{"subtype":"error","request_id":"x","error":"Unsupported control request subtype: list_models"}}'
    expect(parse(unsupported)).toEqual([])
    expect(parse('')).toEqual([])
    expect(parse('garbage')).toEqual([])
  })

  it('merges discovered Claude variants after the seed and overlays matched labels', () => {
    const catalog = getAgentSessionOptionCatalog('claude')!
    const merged = mergeCatalogModels(catalog.models, [
      { id: 'opus[1m]', label: 'Opus (1M context)', options: [] },
      { id: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · Efficient', options: [] }
    ])
    expect(merged.map(({ id }) => id)).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'opus[1m]'])
    const sonnet = merged.find((model) => model.id === 'sonnet')!
    expect(sonnet.description).toBe('Sonnet 5 · Efficient')
    expect(sonnet.isDefault).toBe(true)
    expect(sonnet.options.map(({ id }) => id)).toEqual(['effort'])
  })

  it('parses Cursor model discovery without treating headings as models', () => {
    const parsed = getAgentSessionOptionCatalog('cursor')!.listModels!.parse(
      'Available models:\n- auto (default)\n- gpt-5.3-codex\nmodels\n'
    )
    expect(parsed.map(({ id }) => id)).toEqual(['auto', 'gpt-5.3-codex'])
  })

  it('composes Cursor effort and fast mode into the supported slug form', () => {
    const resolved = resolveAgentSessionOptionLaunch('cursor', {
      model: 'gpt-5.3-codex',
      effort: 'high',
      fastMode: true
    })
    expect(resolved.args).toEqual(['--model', 'gpt-5.3-codex-high-fast'])
    expect(resolved.appliedValues).toEqual({
      model: 'gpt-5.3-codex',
      effort: 'high',
      fastMode: true
    })
  })

  it('passes a requested Codex effort through launch args instead of capping it', () => {
    expect(
      resolveAgentSessionOptionLaunch('codex', { model: 'gpt-5.6-luna', effort: 'max' })
    ).toEqual({
      args: ['-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort=max'],
      appliedValues: { model: 'gpt-5.6-luna', effort: 'max' }
    })
    expect(
      resolveAgentSessionOptionLaunch('codex', { model: 'gpt-5.6-sol', effort: 'ultra' })
    ).toEqual({
      args: ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=ultra'],
      appliedValues: { model: 'gpt-5.6-sol', effort: 'ultra' }
    })
  })

  it('passes unknown model and option values through launch mappings', () => {
    expect(
      resolveAgentSessionOptionLaunch('claude', {
        model: 'claude-future',
        effort: 'future-effort'
      })
    ).toEqual({ args: ['--model', 'claude-future'], appliedValues: { model: 'claude-future' } })
    expect(
      resolveAgentSessionOptionLaunch('claude', { model: 'opus', effort: 'future-effort' })
    ).toMatchObject({
      args: ['--model', 'opus', '--effort', 'future-effort'],
      appliedValues: { model: 'opus', effort: 'future-effort' }
    })
  })

  it('resolves only stored values without leaking values across models', () => {
    let persisted = updateNativeChatSessionOptionDefaults({
      persisted: undefined,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'model',
      value: 'opus'
    })
    persisted = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'effort',
      value: 'xhigh'
    })
    persisted = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'claude',
      modelId: 'sonnet',
      optionId: 'model',
      value: 'sonnet'
    })

    expect(resolveNativeChatSessionOptionDefaults(persisted, 'claude')).toEqual({
      model: 'sonnet'
    })
    expect(persisted.claude?.valuesByModel?.opus).toEqual({ effort: 'xhigh' })
  })

  it('spawns vanilla when the user has not explicitly selected a model', () => {
    // Regression (#9085): a fresh launch must not force the catalog default
    // model/effort — the agent must spawn exactly as its own CLI would.
    expect(resolveNativeChatSessionOptionDefaults(undefined, 'claude')).toBeUndefined()
    expect(resolveNativeChatSessionOptionDefaults({}, 'claude')).toBeUndefined()
    expect(resolveNativeChatSessionOptionDefaults({}, 'future-agent')).toBeUndefined()
  })

  it('resolves an explicitly selected model and only its stored options', () => {
    let persisted = updateNativeChatSessionOptionDefaults({
      persisted: undefined,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'model',
      value: 'opus'
    })
    expect(resolveNativeChatSessionOptionDefaults(persisted, 'claude')).toEqual({
      model: 'opus'
    })
    persisted = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'effort',
      value: 'xhigh'
    })
    expect(resolveNativeChatSessionOptionDefaults(persisted, 'claude')).toEqual({
      model: 'opus',
      effort: 'xhigh'
    })
  })

  it('keeps catalog option defaults after the user explicitly selects a model', () => {
    const persisted = updateNativeChatSessionOptionDefaults({
      persisted: undefined,
      agent: 'claude',
      modelId: 'sonnet',
      optionId: 'model',
      value: 'sonnet'
    })
    const defaults = resolveNativeChatSessionOptionDefaults(persisted, 'claude')

    expect(resolveAgentSessionOptionLaunch('claude', defaults)).toEqual({
      args: ['--model', 'sonnet', '--effort', 'high'],
      appliedValues: { model: 'sonnet', effort: 'high' }
    })
  })
})
