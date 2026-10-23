import { describe, expect, it } from 'vitest'
import { mergeAgentChildIdentity } from './agent-child-identity-merge'

const prior = { agentType: 'explorer', model: 'model-a' }

describe('mergeAgentChildIdentity', () => {
  it('keeps the model for a sparse observation of the same agent type', () => {
    expect(mergeAgentChildIdentity(prior, { agentType: 'explorer' })).toEqual(prior)
    expect(mergeAgentChildIdentity(prior, {})).toEqual(prior)
  })

  it('clears the model when the agent type changes without a replacement', () => {
    expect(mergeAgentChildIdentity(prior, { agentType: 'worker' })).toEqual({
      agentType: 'worker',
      model: undefined
    })
  })

  it('takes the replacement model when the agent type changes with one', () => {
    expect(mergeAgentChildIdentity(prior, { agentType: 'worker', model: 'model-b' })).toEqual({
      agentType: 'worker',
      model: 'model-b'
    })
  })

  it('keeps the model when the agent type is first named after it', () => {
    expect(mergeAgentChildIdentity({ model: 'model-a' }, { agentType: 'explorer' })).toEqual(prior)
  })

  it('takes the observation whole when nothing is on record', () => {
    expect(mergeAgentChildIdentity(undefined, { agentType: 'worker' })).toEqual({
      agentType: 'worker',
      model: undefined
    })
  })
})
