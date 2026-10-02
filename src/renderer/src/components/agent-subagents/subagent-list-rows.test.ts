import { aiVaultSessionFixture } from '../../../../shared/ai-vault-session.test-fixture'
import { expect, it } from 'vitest'

import type { AgentSubagentSourceData } from './AgentSubagentContext'
import { splitSubagentRows } from './subagent-list-rows'

it('does not present missing provider status as successful completion or duplicate live children', () => {
  const data: AgentSubagentSourceData = {
    loading: false,
    source: {
      key: 'omp',
      identity: 'omp',
      agent: 'omp',
      sessionId: 'parent',
      transcriptPath: '/host/parent.jsonl',
      target: { kind: 'local' },
      showIdentity: false,
      liveSubagents: [{ id: 'running', state: 'working', startedAt: 1 }]
    },
    sessions: (['running', 'completed', null] as const).map((status) =>
      aiVaultSessionFixture({
        sessionId: status ?? 'unknown',
        title: status ?? 'unknown',
        subagent: { parentSessionId: 'parent', agentType: null, status }
      })
    )
  }
  const rows = splitSubagentRows(data, false)
  expect(rows.active.map((row) => row.id)).toEqual(['running'])
  expect(rows.done.map((row) => row.id)).toEqual(['completed'])
  expect(rows.unknown.map((row) => row.id)).toEqual(['unknown'])
  expect(rows.unknown[0].state).toBe('unverifiable')
})
