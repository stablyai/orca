import { describe, expect, it } from 'vitest'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import {
  agentChildWorkViewsEqual,
  decodeAgentChildWorkViews
} from './agent-status-child-work-view-wire'

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
  it('reads what this build publishes unchanged', () => {
    expect(decodeAgentChildWorkViews(JSON.parse(JSON.stringify([LIVE, SETTLED])))).toEqual([
      LIVE,
      SETTLED
    ])
  })

  it('reads an older host that publishes no views as absent, not as "no children"', () => {
    expect(decodeAgentChildWorkViews(undefined)).toBeUndefined()
    expect(decodeAgentChildWorkViews({ not: 'a list' })).toBeUndefined()
    expect(decodeAgentChildWorkViews([])).toEqual([])
  })

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

  it('withholds a stop it cannot prove and drops only rows it cannot identify', () => {
    const { stoppable: _stoppable, ...unsure } = LIVE
    expect(decodeAgentChildWorkViews([unsure])).toEqual([{ ...LIVE, stoppable: false }])
    expect(
      decodeAgentChildWorkViews([
        { ...LIVE, id: '' },
        { ...LIVE, observedAt: 'soon' },
        { ...LIVE, invocation: null },
        'not a view',
        SETTLED
      ])
    ).toEqual([SETTLED])
  })
})

describe('agentChildWorkViewsEqual', () => {
  it('compares every field, and tolerates only a small evidence-clock advance when asked', () => {
    const ticked = {
      ...LIVE,
      observedAt: 30_150,
      operation: { ...LIVE.operation!, observedAt: 30_150 }
    }
    expect(agentChildWorkViewsEqual([LIVE], [{ ...LIVE }])).toBe(true)
    expect(agentChildWorkViewsEqual([LIVE], [ticked])).toBe(false)
    expect(agentChildWorkViewsEqual([LIVE], [ticked], 60_000)).toBe(true)
    expect(agentChildWorkViewsEqual([LIVE], [{ ...ticked, observedAt: 60_151 }], 60_000)).toBe(
      false
    )
    expect(agentChildWorkViewsEqual([LIVE], [{ ...LIVE, lastMessage: 'Done' }], 60_000)).toBe(false)
    expect(agentChildWorkViewsEqual(undefined, [])).toBe(false)
  })
})
