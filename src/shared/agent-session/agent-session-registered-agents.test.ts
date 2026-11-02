import { describe, expect, it } from 'vitest'
import { decodeAgentSessionAgentsResult } from './agent-session-registered-agents'

const CODEX = {
  agent: 'codex',
  capabilities: {
    rewind: true,
    compact: true,
    threadGoal: true,
    contextUsage: false,
    imagePrompts: true,
    steering: 'inject',
    approvalEnforcement: 'provider'
  }
}

describe('decodeAgentSessionAgentsResult', () => {
  it('reads every well-formed agent', () => {
    expect(decodeAgentSessionAgentsResult({ agents: [CODEX] })).toEqual([CODEX])
  })

  it('drops a row it cannot read and keeps the rest', () => {
    expect(
      decodeAgentSessionAgentsResult({
        agents: [
          { agent: 'not an id!', capabilities: CODEX.capabilities },
          { agent: 'grok' },
          { agent: 'opencode', capabilities: { ...CODEX.capabilities, rewind: 'yes' } },
          CODEX
        ]
      })
    ).toEqual([CODEX])
  })

  it('degrades an arm or flag a newer host adds to the one that claims least', () => {
    expect(
      decodeAgentSessionAgentsResult({
        agents: [
          {
            agent: 'grok',
            capabilities: {
              steering: 'interrupt',
              approvalEnforcement: 'sandbox',
              someLaterCapability: true
            }
          }
        ]
      })
    ).toEqual([
      {
        agent: 'grok',
        capabilities: {
          rewind: false,
          compact: false,
          threadGoal: false,
          contextUsage: false,
          imagePrompts: false,
          steering: 'queue',
          approvalEnforcement: 'orca'
        }
      }
    ])
  })

  it('keeps the first row of a repeated agent', () => {
    const later = { ...CODEX, capabilities: { ...CODEX.capabilities, rewind: false } }
    expect(decodeAgentSessionAgentsResult({ agents: [CODEX, later] })).toEqual([CODEX])
  })

  it('answers null for a reply that is not an agent list', () => {
    expect(decodeAgentSessionAgentsResult(null)).toBeNull()
    expect(decodeAgentSessionAgentsResult({})).toBeNull()
    expect(decodeAgentSessionAgentsResult({ agents: 'claude' })).toBeNull()
  })
})
