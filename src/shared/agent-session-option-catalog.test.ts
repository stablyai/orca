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

  it('restores defaults per model without leaking values across models', () => {
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
      model: 'sonnet',
      effort: 'high'
    })
    expect(persisted.claude?.valuesByModel?.opus).toEqual({ effort: 'xhigh' })
  })

  it('seeds a fresh launch from the catalog defaults', () => {
    expect(resolveNativeChatSessionOptionDefaults(undefined, 'claude')).toEqual({
      model: 'sonnet',
      effort: 'high'
    })
    expect(resolveNativeChatSessionOptionDefaults({}, 'future-agent')).toBeUndefined()
  })
})
