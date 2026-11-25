import { describe, expect, it } from 'vitest'
import { AgentCardSchema } from './agent-card-contract'
import { agentCardAvatar, agentCardOf } from './shared-agent-card'

const agent = {
  avatar: 'mascot:H1',
  avatarColor: '#f4c4cf',
  avatarOutfit: 'tie',
  slack: null,
  linear: null,
  github: null
}

describe('an agent card', () => {
  it("draws the owner's mascot as the owner dressed it, after the trip through the contract", () => {
    const card = AgentCardSchema.parse(JSON.parse(JSON.stringify(agentCardOf(agent))))
    expect(agentCardAvatar(card)).toEqual({
      avatar: 'mascot:H1',
      avatarColor: '#f4c4cf',
      avatarOutfit: 'tie'
    })
  })

  it('carries no picture but a mascot, and draws an unknown one as the initial', () => {
    expect(agentCardOf({ ...agent, avatar: 'upload:7' })).toBeUndefined()
    expect(agentCardOf({ ...agent, avatar: '🐙' })).toBeUndefined()
    expect(agentCardAvatar({ mascot: 'Z9', color: '#f4c4cf' })).toEqual({ avatar: null })
    expect(agentCardAvatar({ mascot: 'H1', color: 'red' })).toEqual({ avatar: 'mascot:H1' })
  })
})
