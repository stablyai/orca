import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { acknowledgedAgentEntry, acknowledgedAgentRow } from './agent-entry-acknowledgement'

const entry: AgentStatusEntry = {
  paneKey: 'tab-1:leaf-1',
  state: 'done',
  prompt: 'Run the tests',
  updatedAt: 2_000,
  stateStartedAt: 2_000,
  stateHistory: []
}

const row: DashboardAgentRow = {
  paneKey: 'tab-1:leaf-1',
  entry,
  tab: {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  },
  agentType: 'claude',
  state: 'done',
  startedAt: 1_000
}

describe('acknowledgedAgentEntry', () => {
  it('carries the acknowledgement beside the entry', () => {
    expect(acknowledgedAgentEntry(entry, 1_500)).toEqual({ ...entry, acknowledgedAt: 1_500 })
    expect(acknowledgedAgentEntry(entry, undefined)).toEqual({
      ...entry,
      acknowledgedAt: undefined
    })
  })

  // Memoized rows and selectors compare by identity, so a rebuild must not hand them a new object.
  it('keeps one object until the entry or its acknowledgement changes', () => {
    const first = acknowledgedAgentEntry(entry, 1_500)
    expect(acknowledgedAgentEntry(entry, 1_500)).toBe(first)
    expect(acknowledgedAgentEntry(entry, 2_000)).not.toBe(first)
    expect(acknowledgedAgentEntry({ ...entry }, 2_000)).not.toBe(first)
  })
})

describe('acknowledgedAgentRow', () => {
  it('joins the row entry, keeping one object per row and acknowledgement', () => {
    const first = acknowledgedAgentRow(row, 2_000)
    expect(first.entry.acknowledgedAt).toBe(2_000)
    expect(first.paneKey).toBe(row.paneKey)
    expect(acknowledgedAgentRow(row, 2_000)).toBe(first)
    expect(acknowledgedAgentRow(row, undefined).entry.acknowledgedAt).toBeUndefined()
  })
})
