import { describe, expect, it } from 'vitest'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import { decodeAgentChildWorkViews } from './agent-status-child-work-view-wire'

const LIVE: AgentChildWorkView = {
  id: 'child-1',
  providerId: 'task-1',
  kind: 'agent',
  name: 'Explore',
  description: 'Map call sites',
  agentType: 'Explore',
  state: 'working',
  membership: 'live',
  operation: { toolName: 'Read', input: 'src/a.ts', basis: 'open', observedAt: 150 },
  lastMessage: 'Reading',
  firstObservedAt: 100,
  observedAt: 150,
  totalTokens: 900,
  stoppable: true,
  invocation: { invocationId: 'toolu_1', generation: 1 }
}

const SETTLED: AgentChildWorkView = {
  id: 'child-2',
  kind: 'command',
  state: 'done',
  membership: 'settled',
  outcome: 'failed',
  parentChildWorkId: 'child-1',
  firstObservedAt: 100,
  observedAt: 200,
  settledAt: 200,
  stoppable: false,
  invocation: { invocationId: 'task-2', generation: 2 }
}

describe('decodeAgentChildWorkViews', () => {
  // Rules 1 and 4 of the remote-wire contract: a newer host's view is read, never refused.
  it('ignores keys and degrades arms a newer host may add, keeping the row', () => {
    const newer = {
      ...LIVE,
      futureField: { nested: true },
      kind: 'teammate',
      state: 'paused',
      operation: { ...LIVE.operation, basis: 'streamed', extra: 1 }
    }
    expect(decodeAgentChildWorkViews([newer])).toEqual([
      {
        ...LIVE,
        kind: 'unknown',
        state: 'unverifiable',
        operation: { ...LIVE.operation, basis: 'reported' }
      }
    ])
    const settledNewer = { ...SETTLED, outcome: 'timed-out', membership: 'settled' }
    expect(decodeAgentChildWorkViews([settledNewer])).toEqual([{ ...SETTLED, outcome: 'unknown' }])
    // A membership this build cannot place asserts nothing about the child.
    expect(decodeAgentChildWorkViews([{ ...LIVE, membership: 'archived' }])).toEqual([
      { ...LIVE, state: 'unverifiable' }
    ])
  })
})
