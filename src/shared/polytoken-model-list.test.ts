import { describe, expect, it } from 'vitest'
import {
  buildPolytokenModelArg,
  parsePolytokenModelList,
  POLYTOKEN_CONFIGURED_DEFAULT_MODEL_ID
} from './polytoken-model-list'

// Trimmed from `polytoken models --format json` on Polytoken 0.8.2.
const FIXTURE = JSON.stringify({
  default_model: 'zai/glm-5.3-flash',
  default_small_model: 'codex/gpt-5.6-luna',
  models: [
    {
      name: 'anthropic/claude-opus-5',
      provider: 'anthropic',
      provider_name: 'claude-opus-5',
      reasoning: {
        type: 'effort',
        can_disable: true,
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_level: 'low'
      },
      selectable: ['anthropic/claude-opus-5', 'anthropic/claude-opus-5(none)'],
      is_default: false
    },
    {
      name: 'zai/glm-5.3-flash',
      provider: 'zai',
      provider_name: 'glm-5.3-flash',
      reasoning: {
        type: 'effort',
        can_disable: false,
        levels: ['low', 'high', 'max'],
        default_level: 'high'
      },
      is_default: true
    },
    { name: 'ollama/plain', provider: 'ollama', provider_name: 'plain' },
    { name: 'zai/glm-5.3-flash', provider: 'zai', provider_name: 'duplicate' },
    { name: '', provider: 'bad' },
    'not-an-object'
  ]
})

describe('parsePolytokenModelList', () => {
  it('maps the real catalog shape to picker models with effort levels and the default flag', () => {
    expect(parsePolytokenModelList(FIXTURE)).toEqual([
      {
        id: 'anthropic/claude-opus-5',
        label: 'Anthropic Claude Opus 5',
        thinkingLevels: [
          { id: 'none', label: 'Off' },
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' },
          { id: 'max', label: 'Max' }
        ],
        defaultThinkingLevel: 'low'
      },
      {
        id: 'zai/glm-5.3-flash',
        label: 'Zai Glm 5.3 Flash',
        isDefault: true,
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' },
          { id: 'max', label: 'Max' }
        ],
        defaultThinkingLevel: 'high'
      },
      { id: 'ollama/plain', label: 'Ollama Plain' }
    ])
  })

  it('returns nothing for malformed, non-object, oversized, or catalog-less output', () => {
    expect(parsePolytokenModelList('')).toEqual([])
    expect(parsePolytokenModelList('{"models": [')).toEqual([])
    expect(parsePolytokenModelList('[]')).toEqual([])
    expect(parsePolytokenModelList('{"default_model":"x"}')).toEqual([])
    expect(parsePolytokenModelList(`{"models":[${'['.repeat(40)}${']'.repeat(40)}]}`)).toEqual([])
    expect(
      parsePolytokenModelList(`{"models":[${'{"name":"a"},'.repeat(3000)}{"name":"z"}]}`)
    ).toHaveLength(2)
  })

  it('encodes the effort level inside the model locator', () => {
    expect(buildPolytokenModelArg('zai/glm-5.3-flash')).toBe('zai/glm-5.3-flash')
    expect(buildPolytokenModelArg('zai/glm-5.3-flash', 'max')).toBe('zai/glm-5.3-flash(max)')
    expect(POLYTOKEN_CONFIGURED_DEFAULT_MODEL_ID).toBe('polytoken:configured-default')
  })
})
