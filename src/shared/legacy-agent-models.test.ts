import { describe, expect, it } from 'vitest'
import { legacyAgentModelIds } from './legacy-agent-models'

type Row = { id: string; isDefault?: boolean; resolvedModel?: string }
const legacy = (agent: string, models: Row[]) => [...legacyAgentModelIds(agent, models)]

describe('legacyAgentModelIds', () => {
  it('folds Codex models superseded in their family or by a newer major line', () => {
    const models: Row[] = [
      { id: 'gpt-6.1-sol' },
      { id: 'gpt-6-astra' },
      { id: 'gpt-6-sol' },
      { id: 'gpt-6-luna' },
      { id: 'gpt-5.6-sol' },
      { id: 'gpt-5.6-terra', isDefault: true },
      { id: 'gpt-daybreak-blue-latest' }
    ]
    expect(legacy('codex', models)).toEqual(['gpt-6-sol', 'gpt-5.6-sol'])
  })

  it('folds Claude aliases whose versioned model is listed', () => {
    const live: Row[] = [
      { id: 'claude-fable-5', resolvedModel: 'claude-fable-5' },
      { id: 'fable', resolvedModel: 'claude-fable-5' },
      { id: 'opusplan', resolvedModel: 'claude-opus-5-5' }
    ]
    expect(legacy('claude', live)).toEqual(['fable'])
    const saved: Row[] = [
      { id: 'claude-opus-5-5[1m]' },
      { id: 'opus[1m]' },
      { id: 'opus' },
      { id: 'sonnet' }
    ]
    expect(legacy('claude', saved)).toEqual(['opus[1m]'])
  })

  it('leaves other agents untouched', () => {
    expect(legacy('grok', [{ id: 'grok-4.5' }, { id: 'grok-4.6' }])).toEqual([])
  })
})
