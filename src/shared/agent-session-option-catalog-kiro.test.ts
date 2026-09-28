import { describe, expect, it } from 'vitest'
import {
  KIRO_SESSION_OPTION_CATALOG,
  parseKiroModelList
} from './agent-session-option-catalog-kiro'
import { findCatalogModel, findCatalogOption } from './agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'

const LIST_MODELS_STDOUT = JSON.stringify({
  models: [
    {
      model_name: 'auto',
      description: 'Models chosen by task',
      model_id: 'auto',
      rate_multiplier: 1,
      rate_unit: 'Credit'
    },
    {
      model_name: 'claude-opus-5',
      description: 'Claude Opus 5 model with 1M context window',
      model_id: 'claude-opus-5',
      rate_multiplier: 2.2,
      rate_unit: 'Credit'
    },
    { model_name: 'qwen3-coder-next', model_id: 'qwen3-coder-next', rate_multiplier: 0.05 }
  ],
  default_model: 'auto'
})

function engineOption() {
  return findCatalogOption(findCatalogModel(KIRO_SESSION_OPTION_CATALOG, 'auto'), 'mode')
}

describe('parseKiroModelList', () => {
  it('reads ids, labels and the CLI-reported default', () => {
    const models = parseKiroModelList(LIST_MODELS_STDOUT)
    expect(models.map((model) => model.id)).toEqual(['auto', 'claude-opus-5', 'qwen3-coder-next'])
    expect(models[0]?.isDefault).toBe(true)
    expect(models[1]?.isDefault).toBeUndefined()
  })

  it('carries the credit multiplier, which is what distinguishes the models on a plan meter', () => {
    const models = parseKiroModelList(LIST_MODELS_STDOUT)
    expect(models[1]?.description).toBe('Claude Opus 5 model with 1M context window · 2.2x Credit')
    expect(models[2]?.description).toBe('0.05x Credit')
  })

  it('returns nothing for output that is not the expected envelope', () => {
    expect(parseKiroModelList('not json')).toEqual([])
    expect(parseKiroModelList('{"models":"nope"}')).toEqual([])
  })
})

describe('Kiro engine selection', () => {
  it('emits no engine flag by default so the installed CLI owns the v2/v3 migration', () => {
    const resolved = resolveAgentSessionOptionLaunch('kiro', { model: 'auto' })
    expect(resolved.args).toEqual(['--model', 'auto', '--effort', 'medium'])
  })

  it('pins an explicitly chosen engine', () => {
    const resolved = resolveAgentSessionOptionLaunch('kiro', { model: 'auto', mode: 'v3' })
    expect(resolved.args).toEqual(['--model', 'auto', '--agent-engine', 'v3', '--effort', 'medium'])
  })

  it('expands spec mode, which only exists under v3', () => {
    const resolved = resolveAgentSessionOptionLaunch('kiro', { model: 'auto', mode: 'v3-spec' })
    expect(resolved.args).toEqual([
      '--model',
      'auto',
      '--agent-engine',
      'v3',
      '--mode',
      'spec',
      '--effort',
      'medium'
    ])
  })

  it('yields to an engine the user already wrote in their own CLI args', () => {
    const option = engineOption()
    expect(option?.apply.agentArgsOverride?.(['--v3'])).toBe(true)
    expect(option?.apply.agentArgsOverride?.(['--agent-engine', 'v2'])).toBe(true)
    expect(option?.apply.agentArgsOverride?.(['--resume'])).toBe(false)
  })

  it('does not offer a mid-session engine switch, which the CLI cannot do', () => {
    expect(engineOption()?.apply.midSession).toEqual({ kind: 'unsupported' })
  })
})
