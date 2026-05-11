import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { buildWorktreeAgentRows } from './useWorktreeAgentRows'

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
      retained: [makeRetained('tab-orphan:0', 'wt-1', 1000)],
      now: 2000
    })

    expect(rows.map((row) => row.paneKey)).toEqual(['tab-orphan:0'])
    expect(rows[0].state).toBe('done')
  })

  it('prefers a live row over a retained snapshot with the same paneKey', () => {
    const liveEntry = makeEntry('tab-1:0', 2000)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [liveEntry],
      retained: [makeRetained('tab-1:0', 'wt-1', 1000)],
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
        makeEntry('tab-1:0', staleAt, { state: 'working', updatedAt: staleAt }),
        makeEntry('tab-2:0', freshDoneAt, { state: 'done', updatedAt: freshDoneAt })
      ],
      retained: [],
      now
    })

    const working = rows.find((r) => r.paneKey === 'tab-1:0')
    const done = rows.find((r) => r.paneKey === 'tab-2:0')
    expect(working?.state).toBe('idle')
    expect(done?.state).toBe('done')
  })
})
