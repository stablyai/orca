import { describe, expect, it } from 'vitest'
import type { DecisionGate } from '../../../../shared/decision-gate-types'
import { mergePendingDecisionGates, parseDecisionGateOptions } from './decision-gate-attention'

function gate(id: string, createdAt = '2026-01-01 00:00:00'): DecisionGate {
  return {
    id,
    task_id: `task_${id}`,
    question: id,
    options: '[]',
    status: 'pending',
    resolution: null,
    created_at: createdAt,
    resolved_at: null
  }
}

describe('decision gate attention', () => {
  it('parses configured options and rejects malformed payloads', () => {
    expect(parseDecisionGateOptions('["yes","no"]')).toEqual(['yes', 'no'])
    expect(parseDecisionGateOptions('{"yes":true}')).toEqual([])
    expect(parseDecisionGateOptions('broken')).toEqual([])
  })

  it('deduplicates by gate id and drops resolved gates', () => {
    const first = gate('gate_a')
    const updated = { ...first, question: 'updated' }
    const resolved = { ...first, status: 'resolved' as const, resolution: 'yes' }

    expect(mergePendingDecisionGates([first], [updated])).toEqual([updated])
    expect(mergePendingDecisionGates([first], [resolved])).toEqual([])
  })

  it('keeps deterministic creation order', () => {
    expect(
      mergePendingDecisionGates(
        [],
        [gate('gate_new', '2026-01-02 00:00:00'), gate('gate_old', '2026-01-01 00:00:00')]
      ).map((item) => item.id)
    ).toEqual(['gate_old', 'gate_new'])
  })
})
