/* eslint-disable max-lines */
import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStateHistoryEntry,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import {
  IDLE,
  buildAttentionByWorktree,
  mostRecentAttentionInHistory,
  resolveAttention,
  type PaneInput
} from './smart-attention'
import type { TerminalLayoutSnapshot, TerminalTab, Worktree } from '../../../../shared/types'

function hookPane(entry: AgentStatusEntry): PaneInput {
  return { kind: 'hook', entry }
}

function hookPanes(entries: AgentStatusEntry[]): PaneInput[] {
  return entries.map((entry) => ({ kind: 'hook', entry }))
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
    terminalTitle: overrides.terminalTitle,
    stateHistory: overrides.stateHistory ?? [],
    interrupted: overrides.interrupted
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
  it('returns null on an empty history', () => {
    expect(mostRecentAttentionInHistory([])).toBeNull()
  })

  it('returns the latest done/blocked/waiting startedAt', () => {
    const result = mostRecentAttentionInHistory([
      makeHistory('working', NOW - 5_000),
      makeHistory('done', NOW - 4_000),
      makeHistory('working', NOW - 3_000),
      makeHistory('blocked', NOW - 2_000),
      makeHistory('working', NOW - 1_000)
    ])
    expect(result).toBe(NOW - 2_000)
  })

  it('skips interrupted done rows', () => {
    expect(
      mostRecentAttentionInHistory([
        makeHistory('done', NOW - 4_000),
        makeHistory('done', NOW - 1_000, true)
      ])
    ).toBe(NOW - 4_000)
  })

  it('returns null when only interrupted dones exist', () => {
    expect(mostRecentAttentionInHistory([makeHistory('done', NOW - 1_000, true)])).toBeNull()
  })

  it('ignores working rows entirely', () => {
    expect(
      mostRecentAttentionInHistory([
        makeHistory('working', NOW - 1_000),
        makeHistory('working', NOW - 2_000)
      ])
    ).toBeNull()
  })

  it('skips history rows with non-finite startedAt', () => {
    // Why: NaN passes through > silently; Infinity would pin the worktree
    // at the top of Class 3 forever. Treat non-finite as missing.
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
  it('returns idle when there are no panes', () => {
    expect(resolveAttention([], NOW)).toEqual(IDLE)
  })

  it('classifies a blocked pane as Class 1 with stateStartedAt', () => {
    const entry = makeEntry({
      paneKey: 't:1',
      state: 'blocked',
      stateStartedAt: NOW - 60_000,
      updatedAt: NOW - 30_000
    })
    expect(resolveAttention([hookPane(entry)], NOW)).toEqual({
      cls: 1,
      attentionTimestamp: NOW - 60_000,
      cause: 'blocked'
    })
  })

  it('classifies a waiting pane as Class 1', () => {
    const entry = makeEntry({
      paneKey: 't:1',
      state: 'waiting',
      stateStartedAt: NOW - 60_000,
      updatedAt: NOW - 30_000
    })
    expect(resolveAttention([hookPane(entry)], NOW).cls).toBe(1)
  })

  it('classifies a done pane as Class 2', () => {
    const entry = makeEntry({
      paneKey: 't:1',
      state: 'done',
      stateStartedAt: NOW - 90_000,
      updatedAt: NOW - 30_000
    })
    expect(resolveAttention([hookPane(entry)], NOW)).toEqual({
      cls: 2,
      attentionTimestamp: NOW - 90_000
    })
  })

  it('treats interrupted done as idle', () => {
    const entry = makeEntry({
      paneKey: 't:1',
      state: 'done',
      interrupted: true,
      stateStartedAt: NOW - 90_000,
      updatedAt: NOW - 30_000
    })
    expect(resolveAttention([hookPane(entry)], NOW)).toEqual(IDLE)
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

  it('falls back to current stateStartedAt when working has no prior attention history', () => {
    const entry = makeEntry({
      paneKey: 't:1',
      state: 'working',
      stateStartedAt: NOW - 10_000,
      updatedAt: NOW - 1_000,
      stateHistory: []
    })
    expect(resolveAttention([hookPane(entry)], NOW)).toEqual({
      cls: 3,
      attentionTimestamp: NOW - 10_000
    })
  })

  it('falls back when history contains only interrupted done rows', () => {
    const entry = makeEntry({
      paneKey: 't:1',
      state: 'working',
      stateStartedAt: NOW - 10_000,
      updatedAt: NOW - 1_000,
      stateHistory: [makeHistory('done', NOW - 60_000, true)]
    })
    expect(resolveAttention([hookPane(entry)], NOW)).toEqual({
      cls: 3,
      attentionTimestamp: NOW - 10_000
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

  it('takes the most attention-demanding class across multiple panes', () => {
    const blocked = makeEntry({
      paneKey: 't:1',
      state: 'blocked',
      stateStartedAt: NOW - 30_000,
      updatedAt: NOW - 1_000
    })
    const done = makeEntry({
      paneKey: 't:2',
      state: 'done',
      stateStartedAt: NOW - 5_000,
      updatedAt: NOW - 1_000
    })
    const working = makeEntry({
      paneKey: 't:3',
      state: 'working',
      stateStartedAt: NOW - 1_000,
      updatedAt: NOW - 100
    })
    expect(resolveAttention(hookPanes([done, working, blocked]), NOW).cls).toBe(1)
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
      attentionTimestamp: NOW - 5_000,
      cause: 'blocked'
    })
  })

  it('skips entries with non-finite stateStartedAt', () => {
    // Why: NaN > anything === false, so without the guard a corrupted entry
    // would silently sink the worktree to the bottom of its class.
    const corrupted = makeEntry({
      paneKey: 't:1',
      state: 'blocked',
      stateStartedAt: Number.NaN,
      updatedAt: NOW - 1_000
    })
    expect(resolveAttention([hookPane(corrupted)], NOW)).toEqual(IDLE)
  })

  it('title-heuristic permission maps to Class 1 with ts = now', () => {
    expect(
      resolveAttention(
        [{ kind: 'title', status: 'permission', worktreeLastActivityAt: NOW - 60_000 }],
        NOW
      )
    ).toEqual({ cls: 1, attentionTimestamp: NOW, cause: 'title-heuristic' })
  })

  it('title-heuristic working maps to Class 3 with ts = worktree.lastActivityAt', () => {
    expect(
      resolveAttention(
        [{ kind: 'title', status: 'working', worktreeLastActivityAt: NOW - 30_000 }],
        NOW
      )
    ).toEqual({ cls: 3, attentionTimestamp: NOW - 30_000 })
  })

  it('title-heuristic idle / null contributes nothing (Class 4)', () => {
    expect(
      resolveAttention(
        [
          { kind: 'title', status: 'idle', worktreeLastActivityAt: NOW - 1_000 },
          { kind: 'title', status: null, worktreeLastActivityAt: NOW - 1_000 }
        ],
        NOW
      )
    ).toEqual(IDLE)
  })

  it('hook entry overrides title heuristic on the same pane (hook wins when fresh)', () => {
    // Why: per-pane authority means a fresh hook entry beats whatever the
    // title says — a 'done' hook plus a 'working'-classified title stays
    // Class 2.
    const done = makeEntry({
      paneKey: 't:1',
      state: 'done',
      stateStartedAt: NOW - 30_000,
      updatedAt: NOW - 1_000
    })
    expect(
      resolveAttention(
        [
          hookPane(done),
          { kind: 'title', status: 'working', worktreeLastActivityAt: NOW - 60_000 }
        ],
        NOW
      ).cls
    ).toBe(2)
  })

  it('per-pane authority across panes: pane A hook=done, pane B title=permission → Class 1', () => {
    // Why: hook authority is per-pane, not per-worktree. A hookless pane
    // showing 'permission' must still promote the whole worktree to Class 1.
    const done = makeEntry({
      paneKey: 'tab:1',
      state: 'done',
      stateStartedAt: NOW - 30_000,
      updatedAt: NOW - 1_000
    })
    expect(
      resolveAttention(
        [
          hookPane(done),
          { kind: 'title', status: 'permission', worktreeLastActivityAt: NOW - 1_000 }
        ],
        NOW
      )
    ).toEqual({ cls: 1, attentionTimestamp: NOW, cause: 'title-heuristic' })
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

  it('returns IDLE for worktrees with no tabs', () => {
    const w = makeWorktree('wt-1')
    const map = buildAttentionByWorktree([w], {}, {}, {}, {}, NOW)
    expect(map.get(w.id)).toEqual(IDLE)
  })

  it('aggregates entries across multiple panes on the same tab', () => {
    const w = makeWorktree('wt-1')
    const tab = makeTab('tab-1', w.id)
    const entries: Record<string, AgentStatusEntry> = {
      [paneKey(tab.id, LEAF_1)]: makeEntry({
        paneKey: paneKey(tab.id, LEAF_1),
        state: 'working',
        stateStartedAt: NOW - 10_000,
        updatedAt: NOW - 1_000
      }),
      [paneKey(tab.id, LEAF_2)]: makeEntry({
        paneKey: paneKey(tab.id, LEAF_2),
        state: 'blocked',
        stateStartedAt: NOW - 5_000,
        updatedAt: NOW - 1_000
      })
    }
    const map = buildAttentionByWorktree([w], { [w.id]: [tab] }, entries, {}, ptyMap([tab.id]), NOW)
    expect(map.get(w.id)).toEqual({
      cls: 1,
      attentionTimestamp: NOW - 5_000,
      cause: 'blocked'
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
      attentionTimestamp: NOW,
      cause: 'title-heuristic'
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
      attentionTimestamp: NOW,
      cause: 'title-heuristic'
    })
  })

  it('does not fire title fallback for tabs without a live PTY', () => {
    // Why: runtimePaneTitlesByTabId is preserved under sleep; without the
    // tabHasLivePty gate, a slept tab whose preserved title still matches a
    // working pattern would leak into the comparator.
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
