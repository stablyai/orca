import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'
import { resolveAgentChildWorkFreshness } from './agent-status-child-work-freshness'
import {
  projectAgentChildWorkLegacyBackgroundTasks,
  projectAgentChildWorkLegacySubagents,
  type AgentChildWorkLegacyProjectionCandidate
} from './agent-status-child-work-projection'
import type { AgentChildWorkState } from './agent-status-child-work'

function candidate(
  providerId: string,
  overrides: Partial<AgentChildWorkLegacyProjectionCandidate['child']> = {}
): AgentChildWorkLegacyProjectionCandidate {
  return {
    providerId,
    child: {
      kind: 'agent',
      state: 'working',
      membership: 'live',
      firstObservedAt: 123,
      description: 'Investigate',
      agentType: 'researcher',
      model: 'model-a',
      stoppable: true,
      ...overrides
    }
  }
}

describe('agent child-work legacy projection', () => {
  it('preserves the bridge state mapping and stable host first-observation time', () => {
    const states: (AgentChildWorkState | undefined)[] = [
      undefined,
      'working',
      'monitoring',
      'done',
      'idle',
      'waiting',
      'blocked',
      'unverifiable'
    ]
    const projected = projectAgentChildWorkLegacySubagents(
      states.map((state, index) => candidate(`task-${index}`, { state }))
    )

    expect(projected?.map((item) => item.state)).toEqual([
      'working',
      'working',
      'working',
      'idle',
      'idle',
      'waiting',
      'blocked',
      'unverifiable'
    ])
    expect(projected?.every((item) => item.startedAt === 123)).toBe(true)
  })

  it('admits only agent kind and trims bounded nonempty provider ids', () => {
    const projected = projectAgentChildWorkLegacySubagents([
      candidate('  valid-id  '),
      candidate(''),
      candidate(' '.repeat(10)),
      candidate('x'.repeat(65)),
      candidate('workflow-id', { kind: 'workflow' }),
      candidate('command-id', { kind: 'command' }),
      candidate('monitor-id', { kind: 'monitor' }),
      candidate('unknown-id', { kind: 'unknown' })
    ])

    expect(projected).toEqual([
      {
        id: 'valid-id',
        state: 'working',
        startedAt: 123,
        agentType: 'researcher',
        model: 'model-a',
        description: 'Investigate'
      }
    ])
  })

  it.each([31, 32, 33])('caps after accepting %i valid rows in source order', (count) => {
    const interleaved = Array.from({ length: count }, (_, index) => [
      candidate('', { kind: 'agent' }),
      candidate(`task-${index}`)
    ]).flat()
    const projected = projectAgentChildWorkLegacySubagents(interleaved)

    expect(projected).toHaveLength(Math.min(count, AGENT_STATUS_MAX_SUBAGENTS))
    expect(projected?.at(-1)?.id).toBe(`task-${Math.min(count, AGENT_STATUS_MAX_SUBAGENTS) - 1}`)
  })

  it('rejects missing host first-observation time instead of inventing zero', () => {
    expect(
      projectAgentChildWorkLegacySubagents([
        candidate('task-invalid', { firstObservedAt: Number.NaN }),
        candidate('task-valid', { firstObservedAt: 55 })
      ])
    ).toMatchObject([{ id: 'task-valid', startedAt: 55 }])
  })

  it('projects every kind into separate live and settled background lists', () => {
    const projection = projectAgentChildWorkLegacyBackgroundTasks([
      candidate('agent-live', { kind: 'agent', totalTokens: 10 }),
      candidate('workflow-settled', {
        kind: 'workflow',
        state: 'done',
        membership: 'settled'
      }),
      candidate('command-live', { kind: 'command' }),
      candidate('monitor-live', { kind: 'monitor', state: 'monitoring' }),
      candidate('unknown-settled', { kind: 'unknown', state: 'idle', membership: 'settled' })
    ])

    expect(projection.tasks?.map((item) => item.kind)).toEqual(['agent', 'command', 'monitor'])
    expect(projection.settledTasks?.map((item) => item.kind)).toEqual(['workflow', 'unknown'])
    expect(projection.tasks?.[0]).toMatchObject({
      id: 'agent-live',
      startedAt: 123,
      totalTokens: 10,
      stoppable: true
    })
  })
})

describe('resolveAgentChildWorkFreshness', () => {
  it.each([
    [true, 'live', 'working'],
    [false, 'live', 'unverifiable'],
    [true, 'unverifiable', 'unverifiable'],
    [false, 'unverifiable', 'unverifiable']
  ] as const)(
    'maps parentFresh=%s transport=%s to %s for live work',
    (parentEvidenceFresh, transportObservation, expected) => {
      expect(
        resolveAgentChildWorkFreshness({
          state: 'working',
          membership: 'live',
          parentEvidenceFresh,
          transportObservation
        })
      ).toBe(expected)
    }
  )

  it('preserves idle evidence and settled history on contact loss', () => {
    expect(
      resolveAgentChildWorkFreshness({
        state: 'idle',
        membership: 'live',
        parentEvidenceFresh: false,
        transportObservation: 'live'
      })
    ).toBe('idle')
    expect(
      resolveAgentChildWorkFreshness({
        state: 'done',
        membership: 'settled',
        parentEvidenceFresh: false,
        transportObservation: 'unverifiable'
      })
    ).toBe('done')
  })
})
