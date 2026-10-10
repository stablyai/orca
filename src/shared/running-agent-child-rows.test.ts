import { describe, expect, it } from 'vitest'
import type { AgentChildRowContext } from './agent-child-row-model'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import { buildRunningAgentChildRowModels } from './running-agent-child-rows'

const context: AgentChildRowContext = {
  parentEvidenceFresh: true,
  transportObservation: 'live',
  parentObservedAt: 1_000,
  hostClockOffsetMs: 0
}

function child(id: string, fields: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id,
    kind: 'agent',
    name: id,
    state: 'working',
    membership: 'live',
    firstObservedAt: 100,
    observedAt: 900,
    stoppable: false,
    invocation: { invocationId: `spawn-${id}`, generation: 1 },
    ...fields
  }
}

describe('running agents in workspace lists', () => {
  it('shows nothing when an older host supplies no child data', () => {
    expect(buildRunningAgentChildRowModels({}, context)).toEqual([])
  })

  it('keeps the host order of CLI agents, including waiting and idle teammates', () => {
    const rows = buildRunningAgentChildRowModels(
      {
        subagents: [
          { id: 'a', description: 'Review tests', state: 'working', startedAt: 100 },
          { id: 'b', description: 'Check navigation', state: 'waiting', startedAt: 200 },
          { id: 'c', description: 'Teammate', state: 'idle', startedAt: 300 }
        ]
      },
      context
    )
    expect(rows.map((row) => [row.id, row.name, row.displayState])).toEqual([
      ['a', 'Review tests', 'working'],
      ['b', 'Check navigation', 'waiting'],
      ['c', 'Teammate', 'idle']
    ])
  })

  it('prefers authoritative views, including an empty roster, to legacy snapshots', () => {
    expect(
      buildRunningAgentChildRowModels(
        { children: [], subagents: [{ id: 'old', state: 'working', startedAt: 100 }] },
        context
      )
    ).toEqual([])
  })

  it('lists native agents and nested agents, excluding completed work and standalone commands', () => {
    const rows = buildRunningAgentChildRowModels(
      {
        children: [
          child('parent'),
          child('nested', { parentChildWorkId: 'parent' }),
          child('shell', { kind: 'command' }),
          child('finished', {
            state: 'done',
            membership: 'settled',
            outcome: 'succeeded',
            settledAt: 950
          })
        ]
      },
      context
    )
    expect(rows.map((row) => row.id)).toEqual(['parent', 'nested'])
  })

  it('retains a settled owner while its command runs, with the shared monitoring state', () => {
    const rows = buildRunningAgentChildRowModels(
      {
        children: [
          child('owner', {
            state: 'done',
            membership: 'settled',
            outcome: 'succeeded',
            settledAt: 950
          }),
          child('shell', { kind: 'command', parentChildWorkId: 'owner' })
        ]
      },
      context
    )
    expect(rows.map((row) => [row.id, row.displayState])).toEqual([['owner', 'monitoring']])
  })

  it.each(['stale-parent', 'disconnected'] as const)(
    'keeps live claims unverifiable for %s without declaring exit',
    (reason) => {
      const lost: AgentChildRowContext = {
        ...context,
        parentEvidenceFresh: reason !== 'stale-parent',
        transportObservation: reason === 'disconnected' ? 'unverifiable' : 'live'
      }
      for (const source of [
        { children: [child('a', { state: 'waiting' })] },
        { subagents: [{ id: 'a', state: 'working' as const, startedAt: 100 }] }
      ]) {
        const [row] = buildRunningAgentChildRowModels(source, lost)
        expect(row?.displayState).toBe('unverifiable')
        expect(row?.settled).toBe(false)
      }
    }
  )
})
