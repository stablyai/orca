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

  it('reads each row a bounded number of times on a fresh list', () => {
    for (const size of [20, 200]) {
      for (const agent of ['claude', 'codex']) {
        let reads = 0
        const rows = Array.from(
          { length: size },
          (_, index) =>
            new Proxy(
              agent === 'claude'
                ? { id: `claude-family${index}-5-5`, resolvedModel: `claude-family${index}-5-5` }
                : { id: `gpt-6.1-family${index}` },
              {
                get: (target, key, receiver) => {
                  reads += 1
                  return Reflect.get(target, key, receiver)
                }
              }
            )
        )
        legacy(agent, rows)
        // Index pass, legacy test and result pass each read at most three fields of a row.
        expect(reads).toBeLessThanOrEqual(9 * size)
      }
    }
  })

  it("keeps each agent's classification of the same list apart", () => {
    const rows: Row[] = [
      { id: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5' },
      { id: 'opus', resolvedModel: 'claude-opus-5-5' }
    ]
    expect(legacy('claude', rows)).toEqual(['opus'])
    expect(legacy('codex', rows)).toEqual([])
  })
})
