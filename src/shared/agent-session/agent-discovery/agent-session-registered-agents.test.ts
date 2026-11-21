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
})
