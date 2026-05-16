import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import {
  buildWorktreeAgentRows,
  selectMigrationUnsupportedEntriesForWorktree
} from './useWorktreeAgentRows'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const ORPHAN_PANE_KEY = makePaneKey('tab-orphan', '11111111-1111-4111-8111-111111111111')
const PANE_KEY_1 = makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222')
const PANE_KEY_2 = makePaneKey('tab-2', '33333333-3333-4333-8333-333333333333')

function makeTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeEntry(
  paneKey: string,
  startedAt: number,
  overrides?: Partial<AgentStatusEntry>
): AgentStatusEntry {
  return {
    paneKey,
    state: 'done',
    stateStartedAt: startedAt,
    updatedAt: startedAt,
    stateHistory: [],
    prompt: 'finished prompt',
    agentType: 'claude',
    terminalTitle: undefined,
    interrupted: false,
    ...overrides
  }
}

function makeRetained(paneKey: string, worktreeId: string, startedAt: number): RetainedAgentEntry {
  return {
    entry: makeEntry(paneKey, startedAt),
    worktreeId,
    tab: makeTab(paneKey.slice(0, paneKey.indexOf(':'))),
    agentType: 'claude',
    startedAt
  }
}

describe('buildWorktreeAgentRows', () => {
  it('includes retained rows even when their original tab is no longer current', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [],
      // Why: useWorktreeAgentRows filters retained snapshots by worktreeId, not
      // current tab membership. This is the sidebar behavior that sleep cleanup
      // must counter by dropping worktree-scoped retained rows.
      retained: [makeRetained(ORPHAN_PANE_KEY, 'wt-1', 1000)],
      now: 2000
    })

    expect(rows.map((row) => row.paneKey)).toEqual([ORPHAN_PANE_KEY])
    expect(rows[0].state).toBe('done')
  })

  it('prefers a live row over a retained snapshot with the same paneKey', () => {
    const liveEntry = makeEntry(PANE_KEY_1, 2000)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [liveEntry],
      retained: [makeRetained(PANE_KEY_1, 'wt-1', 1000)],
      now: 3000
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].entry).toBe(liveEntry)
    expect(rows[0].startedAt).toBe(2000)
  })

  it('decays a stale working entry to idle but leaves a stale done entry alone', () => {
    // Why: the freshness scheduler ticks agentStatusEpoch when an entry crosses
    // the stale boundary; the row state machine must collapse working/blocked/
    // waiting to idle but preserve done. Sleep is the most common path that
    // freezes hook entries past their TTL.
    const staleAt = 1000
    const freshDoneAt = 2000
    const now = staleAt + AGENT_STATUS_STALE_AFTER_MS + 1
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1'), makeTab('tab-2')],
      entries: [
        makeEntry(PANE_KEY_1, staleAt, { state: 'working', updatedAt: staleAt }),
        makeEntry(PANE_KEY_2, freshDoneAt, { state: 'done', updatedAt: freshDoneAt })
      ],
      retained: [],
      now
    })

    const working = rows.find((r) => r.paneKey === PANE_KEY_1)
    const done = rows.find((r) => r.paneKey === PANE_KEY_2)
    expect(working?.state).toBe('idle')
    expect(done?.state).toBe('done')
  })
})

describe('selectMigrationUnsupportedEntriesForWorktree', () => {
  it('returns raw migration records so shallow selectors can cache snapshots', () => {
    const unsupported: MigrationUnsupportedPtyEntry = {
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: '44444444-4444-4444-8444-444444444444',
      paneKey: makePaneKey('tab-1', '44444444-4444-4444-8444-444444444444'),
      reason: 'legacy-numeric-pane-key',
      source: 'local',
      updatedAt: 1000
    }
    const state = {
      tabsByWorktree: { 'wt-1': [makeTab('tab-1')] },
      agentStatusByPaneKey: {},
      migrationUnsupportedByPtyId: { 'pty-1': unsupported },
      retainedAgentsByPaneKey: {}
    }

    const first = selectMigrationUnsupportedEntriesForWorktree(state, 'wt-1')
    const second = selectMigrationUnsupportedEntriesForWorktree(state, 'wt-1')

    // Why: the Electron black-screen regression came from creating converted
    // AgentStatusEntry objects inside the Zustand selector. Returning store
    // records preserves element identity for useShallow.
    expect(first).toEqual([unsupported])
    expect(second).toEqual([unsupported])
    expect(first[0]).toBe(second[0])
  })
})
