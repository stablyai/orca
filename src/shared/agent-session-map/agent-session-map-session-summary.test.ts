import { describe, expect, it } from 'vitest'
import type { AgentMap } from './agent-session-map-model'
import { agentMapSessionSummary } from './agent-session-map-session-summary'

function map(overrides: Partial<AgentMap> & { nodes: AgentMap['nodes'] }): AgentMap {
  return { rootId: 'root', edges: [], timeline: [], ...overrides }
}

function node(
  overrides: Partial<AgentMap['nodes'][number]> & { id: string }
): AgentMap['nodes'][number] {
  return {
    kind: 'subagent',
    label: overrides.id,
    firstTs: 1000,
    lastTs: 2000,
    toolCalls: [],
    turns: [],
    requests: [],
    promptCount: 0,
    filesTouched: [],
    ...overrides
  }
}

describe('agentMapSessionSummary', () => {
  it('aggregates tools, files and the newest prompt across nodes', () => {
    const summary = agentMapSessionSummary(
      map({
        nodes: [
          node({
            id: 'root',
            kind: 'main',
            lastTs: 5000,
            lastPromptText: 'older prompt',
            lastPromptTs: 1000,
            toolCalls: [
              { callId: '1', name: 'Bash', summary: '', state: 'completed', startTs: 100 }
            ],
            filesTouched: ['src/a.ts', 'src/b.ts']
          }),
          node({
            id: 'a1',
            lastTs: 9000,
            lastPromptText: 'newer prompt',
            lastPromptTs: 8000,
            toolCalls: [
              { callId: '2', name: 'Read', summary: '', state: 'running', startTs: 200 },
              { callId: '3', name: 'Read', summary: '', state: 'failed', startTs: 300 }
            ],
            filesTouched: ['src/b.ts', 'src/c.ts']
          })
        ]
      })
    )
    expect(summary).toMatchObject({
      agentCount: 2,
      toolCallCount: 3,
      filesTouched: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      lastPromptText: 'newer prompt'
    })
  })

  it('summarizes an empty session as zeros with no prompt', () => {
    const summary = agentMapSessionSummary(map({ nodes: [node({ id: 'root', kind: 'main' })] }))
    expect(summary).toEqual({ agentCount: 1, toolCallCount: 0, filesTouched: [] })
    expect(summary.lastPromptText).toBeUndefined()
  })
})
