import { describe, expect, it } from 'vitest'
import { enrichStructuredAgentEfforts } from './agent-session-model-efforts'

describe('enrichStructuredAgentEfforts', () => {
  it('lets newly listed details replace stored fields while retaining unstated fields', () => {
    const state = {
      catalog: {
        models: [
          {
            id: 'provider/model',
            label: 'Model',
            details: { provider: 'stale', contextWindowTokens: 128_000 },
            options: []
          }
        ],
        modelApply: {}
      },
      catalogSource: 'live' as const,
      record: { agent: 'opencode' as const, values: {} },
      permissionMode: null
    }
    const enriched = enrichStructuredAgentEfforts(state, {
      origin: 'probe',
      fetchedAt: 0,
      models: [
        {
          id: 'provider/model',
          label: 'Model',
          isDefault: false,
          efforts: [],
          details: { provider: 'fresh', reasoning: false }
        }
      ]
    })

    expect(enriched.catalog?.models[0]?.details).toEqual({
      provider: 'fresh',
      contextWindowTokens: 128_000,
      reasoning: false
    })
  })
})
