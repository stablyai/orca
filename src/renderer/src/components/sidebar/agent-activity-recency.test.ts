import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Worktree } from '../../../../shared/worktree/types'
import { makeRepo, makeTerminalTab, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { agentEntryActivityAt, buildAgentActivityByWorktree } from './agent-activity-recency'
import { buildAttentionByWorktree, type WorktreeAttention } from './smart-attention'
import { buildWorktreeComparator, rankDoneLaneByRecency } from './smart-sort'
import { DEFAULT_WORKSPACE_STATUSES } from './workspace-status'

const NOW = new Date('2026-09-20T12:00:00.000Z').getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function entry(
  tabId: string,
  overrides: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'state' | 'stateStartedAt'>
): AgentStatusEntry {
  return {
    prompt: '',
    updatedAt: overrides.stateStartedAt,
    agentType: 'codex',
    paneKey: makePaneKey(tabId, LEAF_ID),
    tabId,
    stateHistory: [],
    ...overrides
  }
}

function ids(worktrees: readonly Worktree[]): string[] {
  return worktrees.map((worktree) => worktree.id)
}

describe('agentEntryActivityAt', () => {
  it('uses the completion time of a finished turn', () => {
    expect(agentEntryActivityAt(entry('tab', { state: 'done', stateStartedAt: NOW - HOUR }))).toBe(
      NOW - HOUR
    )
  })

  it('counts a stopped turn by its start, not by the stop', () => {
    const stopped = entry('tab', {
      state: 'done',
      stateStartedAt: NOW - MINUTE,
      interrupted: true,
      stateHistory: [{ state: 'working', prompt: '', startedAt: NOW - HOUR }]
    })
    expect(agentEntryActivityAt(stopped)).toBe(NOW - HOUR)
  })

  it('ignores non-finite timestamps', () => {
    expect(
      agentEntryActivityAt(entry('tab', { state: 'working', stateStartedAt: Number.NaN }))
    ).toBe(0)
  })
})

describe('buildAgentActivityByWorktree', () => {
  it('lets a mirrored tab own its panes over a stale worktree stamp', () => {
    const a = makeWorktree('wt-a', 'a')
    const b = makeWorktree('wt-b', 'b')
    const stamped = entry('tab-b', {
      state: 'working',
      stateStartedAt: NOW - HOUR,
      worktreeId: 'wt-a'
    })
    const activity = buildAgentActivityByWorktree(
      [a, b],
      { 'wt-b': [makeTerminalTab('tab-b', 'wt-b', 'codex')] },
      { [stamped.paneKey]: stamped }
    )
    expect([...activity]).toEqual([['wt-b', NOW - HOUR]])
  })
})

describe('Done lane under Agent Activity', () => {
  it('orders a recent agent completion above an older workspace with stale attention', () => {
    // Why: `old` keeps a live PTY whose agent went silent days ago (Class 4), `recent`
    // finished a turn 40 minutes ago (aged out of Class 2) without any PTY activity.
    const old = makeWorktree('old', 'old', {
      workspaceStatus: 'completed',
      lastActivityAt: NOW - 30 * DAY
    })
    const recent = makeWorktree('recent', 'recent', {
      workspaceStatus: 'completed',
      lastActivityAt: NOW - 10 * DAY
    })
    const worktrees = [old, recent]
    const tabsByWorktree = {
      old: [makeTerminalTab('tab-old', 'old', 'codex')],
      recent: [makeTerminalTab('tab-recent', 'recent', 'codex')]
    }
    const entries = [
      entry('tab-old', { state: 'working', stateStartedAt: NOW - 3 * DAY }),
      entry('tab-recent', { state: 'done', stateStartedAt: NOW - 40 * MINUTE })
    ]
    const agentStatusByPaneKey = Object.fromEntries(entries.map((e) => [e.paneKey, e]))
    const attention = buildAttentionByWorktree(
      worktrees,
      tabsByWorktree,
      agentStatusByPaneKey,
      {},
      { 'tab-old': ['pty-old'], 'tab-recent': ['pty-recent'] },
      NOW
    )
    const agentActivity = buildAgentActivityByWorktree(
      worktrees,
      tabsByWorktree,
      agentStatusByPaneKey
    )
    const repoMap = new Map([['repo-1', makeRepo()]])
    const sortWith = (ranked: Map<string, WorktreeAttention>): string[] =>
      ids(
        [...worktrees].sort(
          buildWorktreeComparator('smart', repoMap, NOW, ranked, undefined, agentActivity)
        )
      )

    expect(attention.get('old')?.cls).toBe(4)
    // Why: outside the Done lane the unverifiable agent keeps attention priority.
    expect(sortWith(attention)).toEqual(['old', 'recent'])
    expect(
      sortWith(rankDoneLaneByRecency(attention, worktrees, DEFAULT_WORKSPACE_STATUSES))
    ).toEqual(['recent', 'old'])
  })

  it('leaves non-Done lanes with their attention class', () => {
    const wip = makeWorktree('wip', 'wip', { workspaceStatus: 'in-progress' })
    const ranked = rankDoneLaneByRecency(
      new Map([['wip', { cls: 4 as const, attentionTimestamp: NOW }]]),
      [wip],
      DEFAULT_WORKSPACE_STATUSES
    )
    expect(ranked.get('wip')).toEqual({ cls: 4, attentionTimestamp: NOW })
  })
})
