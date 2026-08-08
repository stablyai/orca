import { describe, expect, it } from 'vitest'
import { subagentsInTurn, type AgentSubagentSourceData } from './AgentSubagentContext'

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
})
