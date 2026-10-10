import { describe, expect, it } from 'vitest'
import { decodeAgentSessionAgentsResult } from './agent-session-registered-agents'

// What a host that predates the adoption and history flags lists.
const OLDER_HOST_CODEX_CAPABILITIES = {
  rewind: true,
  compact: true,
  threadGoal: true,
  contextUsage: false,
  imagePrompts: true,
  steering: 'inject',
  approvalEnforcement: 'provider'
}

const CODEX = {
  agent: 'codex',
  capabilities: { ...OLDER_HOST_CODEX_CAPABILITIES, transcriptAdoption: true, sessionHistory: true }
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
          approvalEnforcement: 'orca',
          transcriptAdoption: false,
          sessionHistory: false
        }
      }
    ])
  })

  it("reads an older host's missing adoption and history flags as that build's answer", () => {
    const older = OLDER_HOST_CODEX_CAPABILITIES
    expect(
      decodeAgentSessionAgentsResult({
        agents: [
          { agent: 'codex', capabilities: older },
          { agent: 'claude', capabilities: older },
          { agent: 'opencode', capabilities: older }
        ]
      })?.map(({ agent, capabilities }) => [
        agent,
        capabilities.transcriptAdoption,
        capabilities.sessionHistory
      ])
    ).toEqual([
      ['codex', true, true],
      ['claude', true, true],
      ['opencode', false, false]
    ])
  })

  it("keeps a newer host's stated adoption and history flags", () => {
    expect(
      decodeAgentSessionAgentsResult({
        agents: [
          {
            agent: 'opencode',
            capabilities: { ...CODEX.capabilities, transcriptAdoption: false, sessionHistory: true }
          },
          {
            agent: 'claude',
            capabilities: {
              ...CODEX.capabilities,
              transcriptAdoption: false,
              sessionHistory: false
            }
          }
        ]
      })?.map(({ capabilities }) => [capabilities.transcriptAdoption, capabilities.sessionHistory])
    ).toEqual([
      [false, true],
      [false, false]
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
