import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { KIRO_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-kiro'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { KIRO_MODEL_LIST_ARGS, parseKiroModelList } from './kiro-model-list-probe'

const LISTING = JSON.stringify({
  models: [
    {
      model_name: 'auto',
      description: 'Models chosen by task',
      model_id: 'auto',
      context_window_tokens: 1_000_000,
      rate_multiplier: 1
    },
    {
      model_name: 'claude-opus-5',
      description: 'Claude Opus 5 model with 1M context window',
      model_id: 'claude-opus-5',
      context_window_tokens: 1_000_000,
      rate_multiplier: 2.2
    },
    { model_name: 'missing-id', description: 'not launchable' },
    null
  ],
  default_model: 'auto'
})

describe('kiro model list probe', () => {
  it('uses the machine-readable Kiro listing', () => {
    expect(KIRO_MODEL_LIST_ARGS).toEqual(['chat', '--list-models', '--format', 'json'])
  })

  it('parses launchable models and marks the reported default', () => {
    expect(parseKiroModelList(LISTING)).toEqual([
      {
        id: 'auto',
        label: 'Auto',
        description: 'Models chosen by task',
        isDefault: true
      },
      {
        id: 'claude-opus-5',
        label: 'Claude Opus 5',
        description: 'Claude Opus 5 model with 1M context window'
      }
    ])
  })

  it('returns no models for malformed output', () => {
    expect(parseKiroModelList('not json')).toEqual([])
    expect(parseKiroModelList('{"models":"invalid"}')).toEqual([])
  })
})

describe('kiro session option catalog', () => {
  it('is registered and supports worker launch preferences', () => {
    expect(getAgentSessionOptionCatalog('kiro')).toBe(KIRO_SESSION_OPTION_CATALOG)
    expect(KIRO_SESSION_OPTION_CATALOG.supportsWorkerLaunchPreferences).toBe(true)
  })

  it('discovers the account model list and preserves launch options', () => {
    expect(KIRO_SESSION_OPTION_CATALOG.listModels?.command).toBe(
      'kiro-cli chat --list-models --format json'
    )
    expect(KIRO_SESSION_OPTION_CATALOG.listModels?.parse(LISTING)[1]).toMatchObject({
      id: 'claude-opus-5',
      options: [expect.objectContaining({ id: 'effort' })]
    })
  })

  it('launches a selected model and effort through native Kiro flags', () => {
    expect(
      resolveAgentSessionOptionLaunch('kiro', { model: 'claude-opus-5', effort: 'high' }, [], false)
    ).toEqual({
      args: ['--model', 'claude-opus-5', '--effort', 'high'],
      appliedValues: { model: 'claude-opus-5', effort: 'high' }
    })
  })

  it('does not override explicit user model or effort arguments in the launch receipt', () => {
    expect(
      resolveAgentSessionOptionLaunch(
        'kiro',
        { model: 'claude-opus-5', effort: 'high' },
        ['--model=auto', '--effort', 'medium'],
        false
      ).appliedValues
    ).toEqual({})
  })
})
