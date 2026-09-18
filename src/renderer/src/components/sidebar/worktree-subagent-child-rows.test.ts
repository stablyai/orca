import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, AgentSubagentSnapshot } from '../../../../shared/agent-status-types'
import { agentStatusEvidenceObservedAt } from '../../../../shared/agent-status-freshness'
import { agentNoUpdateLabel } from '@/lib/agent-row-decay-state'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'

const tab: TerminalTab = {
  id: 'parent-tab',
  ptyId: null,
  worktreeId: 'folder-workspace',
  title: 'Parent',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

describe('shared CLI and structured child freshness', () => {
  it.each([
    ['working', true, undefined, 'working'],
    ['working', true, 'live', 'working'],
    ['working', false, undefined, 'unverifiable'],
    ['working', false, 'live', 'unverifiable'],
    ['working', true, 'unverifiable', 'unverifiable'],
    ['working', false, 'unverifiable', 'unverifiable'],
    ['waiting', false, undefined, 'unverifiable'],
    ['waiting', false, 'live', 'unverifiable'],
    ['blocked', false, undefined, 'unverifiable'],
    ['blocked', false, 'live', 'unverifiable'],
    ['idle', false, undefined, 'idle'],
    ['idle', false, 'live', 'idle'],
    ['idle', false, 'unverifiable', 'idle'],
    ['unverifiable', true, 'live', 'unverifiable']
  ] as const)(
    '%s with fresh parent %s and transport %s projects %s',
    (state, parentIsFresh, subagentObservation, expected) => {
      const parentEntry: AgentStatusEntry = {
        paneKey: 'parent-pane',
        tabId: tab.id,
        worktreeId: tab.worktreeId,
        state: 'working',
        prompt: 'parent prompt',
        updatedAt: 100,
        stateStartedAt: 10,
        stateHistory: [],
        subagentObservation,
        subagents: [{ id: 'child', state, startedAt: 20 }]
      }
      const row = buildSubagentChildRows({ parentEntry, tab, parentIsFresh })[0]
      expect(row.state).toBe(expected)
      expect(row.activationPaneKey).toBe(parentEntry.paneKey)
      expect(row.startedAt).toBe(20)
      expect(parentEntry.subagents).toEqual([{ id: 'child', state, startedAt: 20 }])
    }
  )
})

/** Ten minutes of parent silence, so a borrowed clock reads visibly differently
 *  from a child's own. */
const PARENT_UPDATED_AT = 1_000_000
const SPAWNED_AT = 20

function parentWithChildren(subagents: AgentSubagentSnapshot[]): AgentStatusEntry {
  return {
    paneKey: 'parent-pane',
    tabId: tab.id,
    worktreeId: tab.worktreeId,
    state: 'working',
    prompt: 'parent prompt',
    updatedAt: PARENT_UPDATED_AT,
    stateStartedAt: 10,
    stateHistory: [],
    subagents
  }
}

describe('child rows carry their own activity evidence', () => {
  it('times a child from its own observation, not the parent delivery clock', () => {
    const parentEntry = parentWithChildren([
      { id: 'child', state: 'working', startedAt: SPAWNED_AT, evidenceObservedAt: 400_000 }
    ])

    const row = buildSubagentChildRows({ parentEntry, tab, parentIsFresh: true })[0]

    expect(row.entry.evidenceObservedAt).toBe(400_000)
    expect(agentStatusEvidenceObservedAt(row.entry)).toBe(400_000)
    // The spawn stamp still drives the time column and the sibling sort.
    expect(row.startedAt).toBe(SPAWNED_AT)
    expect(row.entry.stateStartedAt).toBe(SPAWNED_AT)
  })

  it('falls back to the parent clock when a host never reported the child one', () => {
    const parentEntry = parentWithChildren([
      { id: 'child', state: 'working', startedAt: SPAWNED_AT }
    ])

    const row = buildSubagentChildRows({ parentEntry, tab, parentIsFresh: true })[0]

    // Absent must read as "this host never said", never as "never active".
    expect(row.entry.evidenceObservedAt).toBeUndefined()
    expect(agentStatusEvidenceObservedAt(row.entry)).toBe(PARENT_UPDATED_AT)
  })

  it('gives two siblings of one parent different recency, not one shared clock', () => {
    const parentEntry = parentWithChildren([
      { id: 'busy', state: 'working', startedAt: SPAWNED_AT, evidenceObservedAt: 999_000 },
      { id: 'quiet', state: 'working', startedAt: SPAWNED_AT, evidenceObservedAt: 400_000 }
    ])

    const [busy, quiet] = buildSubagentChildRows({ parentEntry, tab, parentIsFresh: true })

    expect(agentStatusEvidenceObservedAt(busy.entry)).not.toBe(
      agentStatusEvidenceObservedAt(quiet.entry)
    )
    expect(agentNoUpdateLabel(busy.entry, PARENT_UPDATED_AT)).toBe('No update in 0m')
    expect(agentNoUpdateLabel(quiet.entry, PARENT_UPDATED_AT)).toBe('No update in 10m')
  })
})
