import { describe, expect, it } from 'vitest'
import { buildLegacyAgentChildRowModels, buildLegacyTaskRowModels } from './agent-child-row-model'
import { agentChildRowName } from './agent-child-row-lead-trail'
import { childName } from './agent-child-row-name'

const context = {
  parentEvidenceFresh: true,
  transportObservation: 'live' as const,
  parentObservedAt: 1_000,
  hostClockOffsetMs: 0
}

describe('child row names', () => {
  it('keeps same-role children without a task name apart and leaves named children alone', () => {
    const rows = buildLegacyAgentChildRowModels(
      [
        {
          id: '019fa65f-3144-7151-9c02-cff7a28f316f',
          agentType: 'worker',
          state: 'working',
          startedAt: 1
        },
        {
          id: '019fa65f-3144-7151-9c02-0a1b2c3d4e5f',
          agentType: 'worker',
          state: 'working',
          startedAt: 2
        },
        {
          id: '019fa65f-3144-7151-9c02-aaaaaaaaaaaa',
          agentType: 'worker',
          description: 'lifecycle_audit',
          state: 'working',
          startedAt: 3
        }
      ],
      context
    )

    expect(rows.map((row) => agentChildRowName(row, () => 'Working'))).toEqual([
      'worker (cff7a28f316f)',
      'worker (0a1b2c3d4e5f)',
      'lifecycle_audit'
    ])
  })

  it('treats a role published as the name as no name', () => {
    expect(
      childName({
        name: 'general-purpose',
        agentType: 'general-purpose',
        kind: 'agent',
        id: 'toolu_01AbCdEfGhIjKlMnOp'
      })
    ).toEqual({ name: 'general-purpose', idSuffix: 'EfGhIjKlMnOp' })
  })

  it('suffixes role-named tasks from a task-only roster but keeps an unnamed task plain', () => {
    const rows = buildLegacyTaskRowModels(
      [
        { id: 'task_a1b2', kind: 'agent', name: 'general-purpose' },
        { id: 'task_c3d4', kind: 'agent', name: 'general-purpose' },
        { id: 'task_e5f6', kind: 'agent' }
      ],
      []
    )
    expect(rows.map((row) => agentChildRowName(row, () => 'Working'))).toEqual([
      'general-purpose (task_a1b2)',
      'general-purpose (task_c3d4)',
      'Working'
    ])
  })
})
