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
