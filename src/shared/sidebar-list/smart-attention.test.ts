import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStateHistoryEntry,
  type AgentStatusEntry
} from '../agent-status-types'
import {
  IDLE,
  buildAttentionByWorktree,
  mostRecentAttentionInHistory,
  resolveAttention,
  type PaneInput
} from './smart-attention'
import type { TerminalLayoutSnapshot, TerminalTab } from '../terminal-tab-types'
import type { Worktree } from '../worktree/types'

function hookPane(entry: AgentStatusEntry, hasLivePty = false): PaneInput {
  return { kind: 'hook', entry, hasLivePty }
}

function hookPanes(entries: AgentStatusEntry[]): PaneInput[] {
  return entries.map((entry) => hookPane(entry))
}

const NOW = new Date('2026-03-27T12:00:00.000Z').getTime()
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'

function paneKey(tabId: string, leafId: string): string {
  return `${tabId}:${leafId}`
}

function splitLayout(
  tabId: string,
  firstLeafId = LEAF_1,
  secondLeafId = LEAF_2
): Record<string, TerminalLayoutSnapshot> {
  return {
    [tabId]: {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: firstLeafId },
        second: { type: 'leaf', leafId: secondLeafId }
      },
      activeLeafId: firstLeafId,
      expandedLeafId: null
    }
  }
}

function makeEntry(overrides: Partial<AgentStatusEntry> & { paneKey: string }): AgentStatusEntry {
  return {
    state: overrides.state ?? 'working',
    prompt: overrides.prompt ?? '',
    updatedAt: overrides.updatedAt ?? NOW - 30_000,
    stateStartedAt: overrides.stateStartedAt ?? overrides.updatedAt ?? NOW - 30_000,
    agentType: overrides.agentType ?? 'codex',
    paneKey: overrides.paneKey,
    worktreeId: overrides.worktreeId,
    tabId: overrides.tabId,
    terminalTitle: overrides.terminalTitle,
    stateHistory: overrides.stateHistory ?? [],
    interrupted: overrides.interrupted,
    sessionBoundary: overrides.sessionBoundary,
    restoredUnconfirmed: overrides.restoredUnconfirmed,
    workingMode: overrides.workingMode,
    mainAgent: overrides.mainAgent
  }
}

function makeHistory(
  state: AgentStateHistoryEntry['state'],
  startedAt: number,
  interrupted = false
): AgentStateHistoryEntry {
  return { state, prompt: '', startedAt, interrupted: interrupted || undefined }
}

describe('mostRecentAttentionInHistory', () => {
  it('skips interrupted done rows', () => {
    expect(
      mostRecentAttentionInHistory([
        makeHistory('done', NOW - 4_000),
        makeHistory('done', NOW - 1_000, true)
      ])
    ).toBe(NOW - 4_000)
  })

  it('counts a failed history done as attention and skips a cancelled one', () => {
    expect(
      mostRecentAttentionInHistory([
        makeHistory('done', NOW - 4_000),
        {
          ...makeHistory('done', NOW - 1_000),
          mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: NOW - 1_000 }
        }
      ])
    ).toBe(NOW - 1_000)
    expect(
      mostRecentAttentionInHistory([
        makeHistory('done', NOW - 4_000),
        {
          ...makeHistory('done', NOW - 1_000),
          mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: NOW - 1_000 }
        }
      ])
    ).toBe(NOW - 4_000)
  })

  it('skips history rows with non-finite startedAt', () => {
    // Treat nonfinite timestamps as missing: NaN defeats comparisons and Infinity pins Class 3 forever.
    expect(
      mostRecentAttentionInHistory([
        makeHistory('done', Number.NaN),
        makeHistory('blocked', Number.POSITIVE_INFINITY),
        makeHistory('done', NOW - 5_000)
      ])
    ).toBe(NOW - 5_000)
  })
})

describe('resolveAttention', () => {
  it('treats a session boundary as idle unless it displaced a real completion', () => {
    const boundary = makeEntry({
      paneKey: 't:1',
      state: 'done',
      sessionBoundary: true,
      stateStartedAt: NOW - 1_000,
      updatedAt: NOW - 500
    })
    expect(resolveAttention([hookPane(boundary)], NOW)).toEqual(IDLE)

    boundary.stateHistory = [makeHistory('done', NOW - 90_000)]
    expect(resolveAttention([hookPane(boundary)], NOW)).toEqual({
      cls: 2,
      attentionTimestamp: NOW - 90_000
    })
  })

  it('drops a done pane out of Class 2 once the completion itself ages out', () => {
    const justInside = makeEntry({
      paneKey: 't:1',
      state: 'done',
      stateStartedAt: NOW - AGENT_STATUS_STALE_AFTER_MS,
      updatedAt: NOW - 1_000
    })
    expect(resolveAttention([hookPane(justInside)], NOW)).toEqual({
      cls: 2,
      attentionTimestamp: NOW - AGENT_STATUS_STALE_AFTER_MS
    })

    const justOutside = makeEntry({
      paneKey: 't:1',
      state: 'done',
      stateStartedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
      updatedAt: NOW - 1_000
    })
    expect(resolveAttention([hookPane(justOutside)], NOW)).toEqual(IDLE)
  })

  it('keeps an expired done pane from masking a live working sibling', () => {
    const expiredDone = makeEntry({
      paneKey: 't:1',
      state: 'done',
      stateStartedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000,
      updatedAt: NOW - 1_000
    })
    const working = makeEntry({
      paneKey: 't:2',
      state: 'working',
      stateStartedAt: NOW - 10_000,
      updatedAt: NOW - 1_000
    })
    expect(resolveAttention(hookPanes([expiredDone, working]), NOW)).toEqual({
      cls: 3,
      attentionTimestamp: NOW - 10_000
    })
  })

  it('ages out a session-boundary completion from its real completion time', () => {
    const boundary = makeEntry({
      paneKey: 't:1',
      state: 'done',
      sessionBoundary: true,
      stateStartedAt: NOW - 1_000,
      updatedAt: NOW - 500,
      stateHistory: [makeHistory('done', NOW - AGENT_STATUS_STALE_AFTER_MS - 1)]
    })
    expect(resolveAttention([hookPane(boundary)], NOW)).toEqual(IDLE)
  })

  it('classifies a working pane with prior done as Class 3 with the prior timestamp', () => {
    const entry = makeEntry({
      paneKey: 't:1',
      state: 'working',
      stateStartedAt: NOW - 10_000,
      updatedAt: NOW - 1_000,
      stateHistory: [makeHistory('done', NOW - 5 * 60_000)]
    })
    expect(resolveAttention([hookPane(entry)], NOW)).toEqual({
      cls: 3,
      attentionTimestamp: NOW - 5 * 60_000
    })
  })

  it('uses a reset stateStartedAt for Command Code new prompts while still working', () => {
    const entry = makeEntry({
      paneKey: 't:1',
      state: 'working',
      agentType: 'command-code',
      stateStartedAt: NOW - 2_000,
      updatedAt: NOW - 500,
      stateHistory: [makeHistory('done', NOW - 30 * 60_000)]
    })
    expect(resolveAttention([hookPane(entry)], NOW)).toEqual({
      cls: 3,
      attentionTimestamp: NOW - 2_000
    })
  })

  it('skips stale entries (updatedAt older than the freshness window)', () => {
    const entry = makeEntry({
      paneKey: 't:1',
      state: 'blocked',
      stateStartedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000,
      updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000
    })
    expect(resolveAttention([hookPane(entry)], NOW)).toEqual(IDLE)
  })

  it('within the resolved class, takes the freshest attention timestamp across panes', () => {
    const olderBlocked = makeEntry({
      paneKey: 't:1',
      state: 'blocked',
      stateStartedAt: NOW - 60_000,
      updatedAt: NOW - 1_000
    })
    const newerBlocked = makeEntry({
      paneKey: 't:2',
      state: 'blocked',
      stateStartedAt: NOW - 5_000,
      updatedAt: NOW - 1_000
    })
    expect(resolveAttention(hookPanes([olderBlocked, newerBlocked]), NOW)).toEqual({
      cls: 1,
      attentionTimestamp: NOW - 5_000
    })
  })

  it('skips entries with non-finite stateStartedAt', () => {
    // NaN defeats comparisons and sinks corrupted entries within their class.
    const corrupted = makeEntry({
      paneKey: 't:1',
      state: 'blocked',
      stateStartedAt: Number.NaN,
      updatedAt: NOW - 1_000
    })
    expect(resolveAttention([hookPane(corrupted)], NOW)).toEqual(IDLE)
  })
})

describe('buildAttentionByWorktree', () => {
  function makeWorktree(id: string): Worktree {
    return {
      id,
      repoId: 'repo-1',
      path: `/tmp/${id}`,
      branch: `refs/heads/${id}`,
      head: 'abc',
      isBare: false,
      isMainWorktree: false,
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      comment: '',
      isUnread: false,
      isPinned: false,
      displayName: id,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }

  function makeTab(id: string, worktreeId: string): TerminalTab {
    return {
      id,
      ptyId: 'pty',
      worktreeId,
      title: 'bash',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
  }

  function ptyMap(tabIds: string[]): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const id of tabIds) {
      out[id] = ['pty-1']
    }
    return out
  }

  it('prefers mirrored tab ownership over a stale worktree stamp', () => {
    const stale = makeWorktree('stale-worktree')
    const current = makeWorktree('current-worktree')
    const tab = makeTab('tab-1', current.id)
    const key = paneKey(tab.id, LEAF_1)
    const entries = {
      [key]: makeEntry({
        paneKey: key,
        worktreeId: stale.id,
        tabId: tab.id,
        state: 'blocked',
        stateStartedAt: NOW - 5_000,
        updatedAt: NOW - 1_000
      })
    }

    const attention = buildAttentionByWorktree(
      [stale, current],
      { [current.id]: [tab] },
      entries,
      {},
      ptyMap([tab.id]),
      NOW
    )

    expect(attention.get(stale.id)).toEqual(IDLE)
    expect(attention.get(current.id)).toEqual({
      cls: 1,
      attentionTimestamp: NOW - 5_000
    })
  })

  it('skips malformed paneKeys (no colon)', () => {
    const w = makeWorktree('wt-1')
    const tab = makeTab('tab-1', w.id)
    const map = buildAttentionByWorktree(
      [w],
      { [w.id]: [tab] },
      {
        malformed: makeEntry({
          paneKey: 'malformed',
          state: 'blocked',
          stateStartedAt: NOW - 1_000,
          updatedAt: NOW - 100
        })
      },
      {},
      ptyMap([tab.id]),
      NOW
    )
    expect(map.get(w.id)).toEqual(IDLE)
  })

  it('title-heuristic Class 1: hookless pane with permission title → Class 1 with ts = now', () => {
    const w = makeWorktree('wt-1')
    const tab = makeTab('tab-1', w.id)
    const map = buildAttentionByWorktree(
      [w],
      { [w.id]: [tab] },
      {},
      { [tab.id]: { 1: '✋ Gemini CLI' } },
      ptyMap([tab.id]),
      NOW
    )
    expect(map.get(w.id)).toEqual({
      cls: 1,
      attentionTimestamp: NOW
    })
  })

  it('title-heuristic Class 3: hookless pane with working title → ts = worktree.lastActivityAt', () => {
    const w = { ...makeWorktree('wt-1'), lastActivityAt: NOW - 30_000 }
    const tab = makeTab('tab-1', w.id)
    const map = buildAttentionByWorktree(
      [w],
      { [w.id]: [tab] },
      {},
      { [tab.id]: { 1: '⠋ Claude' } },
      ptyMap([tab.id]),
      NOW
    )
    expect(map.get(w.id)).toEqual({ cls: 3, attentionTimestamp: NOW - 30_000 })
  })

  it('hook overrides title on the same pane (hook=done + working-style title stays Class 2)', () => {
    const w = makeWorktree('wt-1')
    const tab = makeTab('tab-1', w.id)
    const entries: Record<string, AgentStatusEntry> = {
      [paneKey(tab.id, LEAF_1)]: makeEntry({
        paneKey: paneKey(tab.id, LEAF_1),
        state: 'done',
        stateStartedAt: NOW - 30_000,
        updatedAt: NOW - 1_000
      })
    }
    const map = buildAttentionByWorktree(
      [w],
      { [w.id]: [tab] },
      entries,
      // Same paneId 1 — must NOT double-promote into Class 3.
      { [tab.id]: { 1: '⠋ Claude' } },
      ptyMap([tab.id]),
      NOW,
      undefined,
      splitLayout(tab.id)
    )
    expect(map.get(w.id)).toEqual({ cls: 2, attentionTimestamp: NOW - 30_000 })
  })

  it('keeps a restored row idle while allowing an independently live sibling title', () => {
    const w = makeWorktree('wt-1')
    const tab = makeTab('tab-1', w.id)
    const key = paneKey(tab.id, LEAF_1)
    const map = buildAttentionByWorktree(
      [w],
      { [w.id]: [tab] },
      {
        [key]: makeEntry({
          paneKey: key,
          state: 'working',
          restoredUnconfirmed: true
        })
      },
      { [tab.id]: { 1: '⠋ Claude', 2: '✋ Gemini CLI' } },
      ptyMap([tab.id]),
      NOW,
      undefined,
      splitLayout(tab.id)
    )

    expect(map.get(w.id)).toEqual({
      cls: 1,
      attentionTimestamp: NOW
    })
  })

  it('does not revive a restored row from one title before layout hydration', () => {
    const w = makeWorktree('wt-1')
    const tab = makeTab('tab-1', w.id)
    const key = paneKey(tab.id, LEAF_1)
    const map = buildAttentionByWorktree(
      [w],
      { [w.id]: [tab] },
      {
        [key]: makeEntry({
          paneKey: key,
          state: 'working',
          restoredUnconfirmed: true
        })
      },
      { [tab.id]: { 1: '⠋ Claude' } },
      ptyMap([tab.id]),
      NOW
    )

    expect(map.get(w.id)).toEqual(IDLE)
  })

  it('still uses one unmapped title when the hook is only age-stale', () => {
    const w = makeWorktree('wt-1')
    const tab = makeTab('tab-1', w.id)
    const key = paneKey(tab.id, LEAF_1)
    const map = buildAttentionByWorktree(
      [w],
      { [w.id]: [tab] },
      {
        [key]: makeEntry({
          paneKey: key,
          state: 'working',
          updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
        })
      },
      { [tab.id]: { 1: '✋ Gemini CLI' } },
      ptyMap([tab.id]),
      NOW
    )

    expect(map.get(w.id)).toEqual({
      cls: 1,
      attentionTimestamp: NOW
    })
  })

  it('per-pane authority across panes: pane A fresh hook=done, pane B no hook + permission title → Class 1', () => {
    const w = makeWorktree('wt-1')
    const tab = makeTab('tab-1', w.id)
    const entries: Record<string, AgentStatusEntry> = {
      [paneKey(tab.id, LEAF_1)]: makeEntry({
        paneKey: paneKey(tab.id, LEAF_1),
        state: 'done',
        stateStartedAt: NOW - 30_000,
        updatedAt: NOW - 1_000
      })
    }
    const map = buildAttentionByWorktree(
      [w],
      { [w.id]: [tab] },
      entries,
      // Pane 2 has no hook — title fallback fires for it.
      { [tab.id]: { 1: 'something', 2: '✋ Gemini CLI' } },
      ptyMap([tab.id]),
      NOW,
      undefined,
      splitLayout(tab.id)
    )
    expect(map.get(w.id)).toEqual({
      cls: 1,
      attentionTimestamp: NOW
    })
  })

  it('does not fire title fallback for tabs without a live PTY', () => {
    // Titles survive sleep; require live PTY evidence before they can affect attention.
    const w = makeWorktree('wt-1')
    const tab = makeTab('tab-1', w.id)
    const map = buildAttentionByWorktree(
      [w],
      { [w.id]: [tab] },
      {},
      { [tab.id]: { 1: '✋ Gemini CLI' } },
      // No live pty for this tab.
      {},
      NOW
    )
    expect(map.get(w.id)).toEqual(IDLE)
  })
})

describe('resolveAttention reads the combined state, not the main agent fact', () => {
  // Sort the combined state the row displays: a settled main agent with working subagents remains Working.
  const key = paneKey('tab-1', LEAF_1)

  it('ranks a row held working by a subagent as Working, not Done', () => {
    const entry = makeEntry({
      paneKey: key,
      state: 'working',
      stateStartedAt: NOW - 60_000,
      mainAgent: { state: 'done', stateStartedAt: NOW - 30_000 }
    })
    expect(resolveAttention(hookPanes([entry]), NOW)).toEqual({
      cls: 3,
      attentionTimestamp: NOW - 60_000
    })
  })

  it('never treats a restored row as live, whatever its main agent says', () => {
    const entry = makeEntry({
      paneKey: key,
      state: 'working',
      restoredUnconfirmed: true,
      mainAgent: { state: 'working', stateStartedAt: NOW - 30_000 }
    })
    // Even with a live PTY behind it: a hydrated row has no "how long since we heard" to report.
    expect(resolveAttention([hookPane(entry, true)], NOW)).toEqual(IDLE)
    expect(resolveAttention([hookPane(entry, false)], NOW)).toEqual(IDLE)
  })
})
