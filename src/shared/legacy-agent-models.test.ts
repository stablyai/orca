import { describe, expect, it } from 'vitest'
import { classifyAgentModels } from './legacy-agent-models'

type Row = { id: string; isDefault?: boolean; resolvedModel?: string }

describe('classifyAgentModels', () => {
  it('hides a Claude short name only when it reports the listed versioned model it runs', () => {
    const live: Row[] = [
      { id: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5' },
      { id: 'opus', resolvedModel: 'claude-opus-5-5' },
      { id: 'opusplan', resolvedModel: 'claude-opus-5-5' },
      { id: 'sonnet', resolvedModel: 'claude-sonnet-5-5' }
    ]
    const classes = classifyAgentModels('claude', live)
    expect([...classes.hidden]).toEqual(['opus'])
    expect([...classes.legacy]).toEqual(['opusplan'])
  })

  it('only folds a saved short name listed without the model it runs', () => {
    const saved: Row[] = [{ id: 'claude-opus-5-5[1m]' }, { id: 'opus[1m]' }, { id: 'opus' }]
    const classes = classifyAgentModels('claude', saved)
    expect([...classes.hidden]).toEqual([])
    expect([...classes.legacy]).toEqual(['opus[1m]'])
  })
})
