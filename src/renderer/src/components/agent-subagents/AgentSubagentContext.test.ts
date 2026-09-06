import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  subagentDisplayName,
  subagentsInTurn,
  type AgentSubagentSourceData
} from './AgentSubagentContext'

describe('subagentsInTurn', () => {
  it('keeps only children started during the parent turn', () => {
    const data: AgentSubagentSourceData = {
      loading: false,
      sessions: [],
      source: {
        key: 'codex',
        identity: 'codex',
        agent: 'codex',
        paneKey: 'pane',
        sessionId: 'parent',
        transcriptPath: '/tmp/parent.jsonl',
        target: { kind: 'local' },
        liveSubagents: [
          { id: 'before', state: 'working', startedAt: 6_000 },
          { id: 'inside', description: 'Review parser', state: 'working', startedAt: 11_000 },
          { id: 'after', state: 'working', startedAt: 16_000 }
        ]
      }
    }

    expect(subagentsInTurn(data, 10_000, 13_000)).toEqual([
      { id: 'inside', description: 'Review parser', active: true }
    ])
  })

  it('never exposes a provider agent path as a display name', () => {
    expect(subagentDisplayName('/root/test_privet', 'default')).toBe('default')
    expect(subagentDisplayName('Boole', 'default')).toBe('Boole')
  })

  it('links a resumed child to every parent turn that contacted it', () => {
    const data: AgentSubagentSourceData = {
      loading: false,
      sessions: [
        {
          sessionId: 'child',
          title: 'Boole',
          modifiedAt: new Date(1_000).toISOString(),
          subagent: {
            parentSessionId: 'parent',
            agentType: null,
            status: 'completed',
            turnStartedAts: [11_000, 21_000]
          }
        } as AiVaultSession
      ],
      source: {
        key: 'codex',
        identity: 'codex',
        agent: 'codex',
        paneKey: 'pane',
        sessionId: 'parent',
        transcriptPath: '/tmp/parent.jsonl',
        target: { kind: 'local' },
        liveSubagents: []
      }
    }

    expect(subagentsInTurn(data, 20_000, 22_000)).toEqual([
      { id: 'child', description: 'Boole', active: false }
    ])
  })
})
