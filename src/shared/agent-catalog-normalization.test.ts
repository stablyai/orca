// Physical-index integrity of normalized catalog rows: repair mutations splice
// the persisted array by physicalIndex, so every corrupt/duplicate row must
// carry its true persisted position, not a count of previously classified rows.

import { describe, expect, it } from 'vitest'
import type { CustomTuiAgent, CustomTuiAgentId } from './types'
import { normalizeAgentCatalog } from './agent-catalog-normalization'

const UUID_A = '01234567-89ab-4cde-8f01-23456789abcd'
const UUID_B = 'fedcba98-7654-4321-8fed-cba987654321'
const UUID_C = '11111111-2222-4333-8444-555555555555'

function customId(base: string, uuid: string): CustomTuiAgentId {
  return `custom-agent:${base}:${uuid}` as CustomTuiAgentId
}

function liveAgent(overrides: Partial<CustomTuiAgent> = {}): CustomTuiAgent {
  return {
    id: customId('codex', UUID_A),
    baseAgent: 'codex',
    label: 'My Codex',
    args: '',
    env: {},
    syncEnv: false,
    ...overrides
  }
}

describe('duplicate-id rows keep their persisted physical index', () => {
  it('reports the persisted array index when repair-required and tombstone-shadowed rows precede the duplicates', () => {
    const duplicateId = customId('codex', UUID_A)
    const shadowedId = customId('codex', UUID_B)
    // Index 0: valid id but empty label -> repair-required, never a live row.
    const repairRequired = liveAgent({
      id: customId('claude', UUID_C),
      baseAgent: 'claude',
      label: ''
    })
    // Index 1: valid row shadowed by a same-id tombstone, skipped entirely.
    const shadowed = liveAgent({ id: shadowedId, label: 'Shadowed' })
    const duplicateOne = liveAgent({ id: duplicateId, label: 'One' })
    const duplicateTwo = liveAgent({ id: duplicateId, label: 'Two' })
    const persisted = [repairRequired, shadowed, duplicateOne, duplicateTwo]

    const { catalog } = normalizeAgentCatalog({
      customTuiAgents: persisted,
      deletedCustomTuiAgents: [{ id: shadowedId, baseAgent: 'codex', label: 'Old', deletedAt: 1 }],
      disabledTuiAgents: [],
      defaultTuiAgent: 'auto'
    })

    const duplicateRows = catalog.corruptRows.filter((row) => row.id === duplicateId)
    expect(duplicateRows.map((row) => row.physicalIndex)).toEqual([2, 3])

    // Discarding the duplicate group by physicalIndex must remove exactly the
    // duplicate rows and leave the unrelated persisted rows untouched.
    const discarded = new Set(duplicateRows.map((row) => row.physicalIndex))
    const remaining = persisted.filter((_, index) => !discarded.has(index))
    expect(remaining).toEqual([repairRequired, shadowed])
  })
})

describe('corrupt rows sharing a duplicated id join the duplicate group (L1-#4)', () => {
  it('flags a base-mismatch corrupt row with duplicate_id alongside its valid sibling', () => {
    const duplicateId = customId('codex', UUID_A)
    const valid = liveAgent({ id: duplicateId, label: 'One' })
    // Valid id syntax, but the persisted baseAgent disagrees with the id's base:
    // corrupt-kind, not repair-required.
    const baseMismatch = {
      ...liveAgent({ id: duplicateId, label: 'Two' }),
      baseAgent: 'claude' as const
    }

    const { catalog } = normalizeAgentCatalog({
      customTuiAgents: [valid, baseMismatch],
      deletedCustomTuiAgents: [],
      disabledTuiAgents: [],
      defaultTuiAgent: 'auto'
    })

    const groupRows = catalog.corruptRows.filter(
      (row) => row.id === duplicateId && row.issues.some((issue) => issue.reason === 'duplicate_id')
    )
    // Both physical records carry duplicate_id, so resolve-duplicate-id can
    // cover the whole group instead of looping on the mismatch row.
    expect(groupRows.map((row) => row.physicalIndex).sort()).toEqual([0, 1])
    const mismatchRow = groupRows.find((row) => row.physicalIndex === 1)
    expect(mismatchRow?.issues.map((issue) => issue.reason)).toContain('identity_mismatch')
    expect(catalog.liveById.has(duplicateId)).toBe(false)
  })
})
