import { describe, expect, it, vi } from 'vitest'
import type { CustomTuiAgentId } from '../../../../shared/types'
import type { CustomAgentDraft } from '../../../../shared/agent-catalog-snapshot'
import {
  assembleDuplicateRepairMutation,
  countKeepChoices,
  isDuplicateSelectionComplete,
  type DuplicateRepairRow
} from './custom-agent-duplicate-repair-plan'

const DUP_ID = 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as CustomTuiAgentId

function draft(label: string): CustomAgentDraft {
  return { label, commandOverride: null, args: '', env: {}, syncEnv: false }
}

function rows(): DuplicateRepairRow[] {
  return [
    { repairToken: 'a', label: 'One', baseAgent: 'codex', draftAvailability: 'available' },
    { repairToken: 'b', label: 'Two', baseAgent: 'codex', draftAvailability: 'available' }
  ]
}

describe('selection guards', () => {
  it('reports coverage of the whole group', () => {
    expect(isDuplicateSelectionComplete(rows(), { a: 'keep' })).toBe(false)
    expect(isDuplicateSelectionComplete(rows(), { a: 'keep', b: 'discard' })).toBe(true)
  })

  it('counts keep choices', () => {
    expect(countKeepChoices({ a: 'keep', b: 'keep' })).toBe(2)
    expect(countKeepChoices({ a: 'keep', b: 'discard' })).toBe(1)
  })
})

describe('assembleDuplicateRepairMutation', () => {
  it('rejects an incomplete selection before any draft fetch', async () => {
    const fetchDraft = vi.fn()
    const result = await assembleDuplicateRepairMutation({
      duplicateId: DUP_ID,
      rows: rows(),
      selection: { a: 'keep' },
      fetchDraft
    })
    expect(result).toEqual({ ok: false, reason: 'incomplete' })
    expect(fetchDraft).not.toHaveBeenCalled()
  })

  it('rejects more than one keep', async () => {
    const result = await assembleDuplicateRepairMutation({
      duplicateId: DUP_ID,
      rows: rows(),
      selection: { a: 'keep', b: 'keep' },
      fetchDraft: vi.fn()
    })
    expect(result).toEqual({ ok: false, reason: 'multiple-keep' })
  })

  it('fetches drafts only for keep/replace and builds the atomic group', async () => {
    const fetchDraft = vi.fn(async (token: string) => draft(`draft-${token}`))
    const result = await assembleDuplicateRepairMutation({
      duplicateId: DUP_ID,
      rows: rows(),
      selection: { a: 'keep', b: 'replace' },
      fetchDraft
    })
    expect(fetchDraft).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      ok: true,
      mutation: {
        kind: 'resolve-duplicate-id',
        duplicateId: DUP_ID,
        rows: [
          {
            repairToken: 'a',
            action: { kind: 'keep-for-existing-references', repairedDraft: draft('draft-a') }
          },
          {
            repairToken: 'b',
            action: { kind: 'replace', baseAgent: 'codex', draft: draft('draft-b') }
          }
        ]
      }
    })
  })

  it('does not fetch a draft for a discarded row', async () => {
    const fetchDraft = vi.fn(async () => draft('x'))
    const result = await assembleDuplicateRepairMutation({
      duplicateId: DUP_ID,
      rows: rows(),
      selection: { a: 'keep', b: 'discard' },
      fetchDraft
    })
    expect(fetchDraft).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mutation.rows[1]).toEqual({ repairToken: 'b', action: { kind: 'discard' } })
    }
  })

  it('fails when a kept row draft is unreadable at this revision', async () => {
    const result = await assembleDuplicateRepairMutation({
      duplicateId: DUP_ID,
      rows: rows(),
      selection: { a: 'keep', b: 'discard' },
      fetchDraft: vi.fn(async () => 'too-large' as const)
    })
    expect(result).toEqual({ ok: false, reason: 'draft-unavailable' })
  })
})
