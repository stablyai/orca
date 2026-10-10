import { describe, expect, it } from 'vitest'
import {
  agentModelListNames,
  agentModelListReplacement,
  nearestAgentEffort
} from './agent-session-model-fallback'

describe('a replaced model', () => {
  it('carries the effort to the nearest level the replacement offers, the higher on a tie', () => {
    expect(nearestAgentEffort('high', ['low', 'high'])).toBe('high')
    expect(nearestAgentEffort('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh')
    expect(nearestAgentEffort('xhigh', ['low', 'high'])).toBe('high')
    expect(nearestAgentEffort('medium', ['low', 'high'])).toBe('high')
    expect(nearestAgentEffort('minimal', ['medium', 'high'])).toBe('medium')
  })

  it('carries no effort the replacement cannot take', () => {
    expect(nearestAgentEffort('high', [])).toBeUndefined()
    expect(nearestAgentEffort('turbo', ['low', 'high'])).toBeUndefined()
    expect(nearestAgentEffort(undefined, ['low'])).toBeUndefined()
  })

  it('names a selection saved as an alias or as the id that alias runs', () => {
    const models = [
      { id: 'opus[1m]', isDefault: false },
      { id: 'sonnet', isDefault: true, resolvedModel: 'claude-sonnet-5' }
    ]
    expect(agentModelListNames(models, 'sonnet')).toBe(true)
    expect(agentModelListNames(models, 'claude-sonnet-5')).toBe(true)
    expect(agentModelListNames(models, 'claude-opus-4-1-20250805')).toBe(false)
    expect(agentModelListReplacement(models)).toBe('sonnet')
    expect(agentModelListReplacement([{ id: 'haiku' }, { id: 'opus' }])).toBe('haiku')
    expect(agentModelListReplacement([])).toBeNull()
  })
})
