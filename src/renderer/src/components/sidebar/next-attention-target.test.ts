import { describe, expect, it } from 'vitest'
import { findNextAttentionTarget } from './next-attention-target'
import type { WorktreeAttention } from './smart-attention'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const NOW = 1_000_000

function makeWaitingEntry(overrides: Partial<AgentStatusEntry> & { paneKey: string }) {
  return {
    state: 'waiting',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    ...overrides
  } as AgentStatusEntry
}

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const CLASS_1 = (attentionTimestamp: number): WorktreeAttention => ({
  cls: 1,
  attentionTimestamp,
  cause: 'waiting'
})

describe('findNextAttentionTarget', () => {
  it('targets the most recent waiting worktree and its freshest waiting pane', () => {
    const target = findNextAttentionTarget({
      attentionByWorktree: new Map<string, WorktreeAttention>([
        ['wt-old', CLASS_1(NOW - 5_000)],
        ['wt-new', CLASS_1(NOW - 1_000)],
        ['wt-working', { cls: 3, attentionTimestamp: NOW }]
      ]),
      agentStatusByPaneKey: {
        [`tab-1:${LEAF_A}`]: makeWaitingEntry({
          paneKey: `tab-1:${LEAF_A}`,
          worktreeId: 'wt-new',
          stateStartedAt: NOW - 4_000
        }),
        [`tab-1:${LEAF_B}`]: makeWaitingEntry({
          paneKey: `tab-1:${LEAF_B}`,
          worktreeId: 'wt-new',
          stateStartedAt: NOW - 1_000
        })
      },
      tabsByWorktree: { 'wt-new': [makeTab('tab-1', 'wt-new')] },
      eligibleWorktreeIds: new Set(['wt-old', 'wt-new', 'wt-working']),
      activeWorktreeId: null,
      now: NOW
    })

    expect(target).toEqual({ worktreeId: 'wt-new', tabId: 'tab-1', leafId: LEAF_B })
  })

  it('skips the worktree already on screen so repeated presses walk the queue', () => {
    const args = {
      attentionByWorktree: new Map([
        ['wt-a', CLASS_1(NOW - 1_000)],
        ['wt-b', CLASS_1(NOW - 2_000)]
      ]),
      agentStatusByPaneKey: {},
      tabsByWorktree: {},
      eligibleWorktreeIds: new Set(['wt-a', 'wt-b']),
      now: NOW
    }

    expect(findNextAttentionTarget({ ...args, activeWorktreeId: null })?.worktreeId).toBe('wt-a')
    expect(findNextAttentionTarget({ ...args, activeWorktreeId: 'wt-a' })?.worktreeId).toBe('wt-b')
    // Why: the last waiting agent stays reachable rather than falling through to nothing.
    expect(
      findNextAttentionTarget({
        ...args,
        attentionByWorktree: new Map([['wt-a', CLASS_1(NOW)]]),
        eligibleWorktreeIds: new Set(['wt-a']),
        activeWorktreeId: 'wt-a'
      })?.worktreeId
    ).toBe('wt-a')
  })

  it('returns null when nothing waits, and ignores worktrees outside the eligible set', () => {
    const attentionByWorktree = new Map([['wt-archived', CLASS_1(NOW)]])

    expect(
      findNextAttentionTarget({
        attentionByWorktree: new Map<string, WorktreeAttention>([
          ['wt-a', { cls: 3, attentionTimestamp: NOW }]
        ]),
        agentStatusByPaneKey: {},
        tabsByWorktree: {},
        eligibleWorktreeIds: new Set(['wt-a']),
        activeWorktreeId: null,
        now: NOW
      })
    ).toBeNull()

    expect(
      findNextAttentionTarget({
        attentionByWorktree,
        agentStatusByPaneKey: {},
        tabsByWorktree: {},
        eligibleWorktreeIds: new Set<string>(),
        activeWorktreeId: null,
        now: NOW
      })
    ).toBeNull()
  })

  it('attributes a pane by tab ownership when the hook row carries no worktree stamp', () => {
    const target = findNextAttentionTarget({
      attentionByWorktree: new Map([['wt-a', CLASS_1(NOW)]]),
      agentStatusByPaneKey: {
        [`tab-9:${LEAF_A}`]: makeWaitingEntry({ paneKey: `tab-9:${LEAF_A}` })
      },
      tabsByWorktree: { 'wt-a': [makeTab('tab-9', 'wt-a')] },
      eligibleWorktreeIds: new Set(['wt-a']),
      activeWorktreeId: null,
      now: NOW
    })

    expect(target).toEqual({ worktreeId: 'wt-a', tabId: 'tab-9', leafId: LEAF_A })
  })

  it('refuses a pane whose tab belongs to another worktree, even when the row is stamped here', () => {
    const target = findNextAttentionTarget({
      attentionByWorktree: new Map([['wt-a', CLASS_1(NOW)]]),
      agentStatusByPaneKey: {
        [`tab-a:${LEAF_A}`]: makeWaitingEntry({
          paneKey: `tab-a:${LEAF_A}`,
          worktreeId: 'wt-a',
          stateStartedAt: NOW - 5_000
        }),
        [`tab-b:${LEAF_B}`]: makeWaitingEntry({
          paneKey: `tab-b:${LEAF_B}`,
          worktreeId: 'wt-a',
          stateStartedAt: NOW
        })
      },
      tabsByWorktree: { 'wt-a': [makeTab('tab-a', 'wt-a')], 'wt-b': [makeTab('tab-b', 'wt-b')] },
      eligibleWorktreeIds: new Set(['wt-a']),
      activeWorktreeId: null,
      now: NOW
    })

    // The fresher row names wt-b's tab; focusing it would reveal another worktree's pane.
    expect(target).toEqual({ worktreeId: 'wt-a', tabId: 'tab-a', leafId: LEAF_A })
  })

  it('still targets the worktree when its only waiting row is stale or unroutable', () => {
    const target = findNextAttentionTarget({
      attentionByWorktree: new Map([['wt-a', CLASS_1(NOW)]]),
      agentStatusByPaneKey: {
        [`tab-1:${LEAF_A}`]: makeWaitingEntry({
          paneKey: `tab-1:${LEAF_A}`,
          worktreeId: 'wt-a',
          updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
        }),
        'tab-2:7': makeWaitingEntry({ paneKey: 'tab-2:7', worktreeId: 'wt-a' })
      },
      tabsByWorktree: { 'wt-a': [makeTab('tab-1', 'wt-a')] },
      eligibleWorktreeIds: new Set(['wt-a']),
      activeWorktreeId: null,
      now: NOW
    })

    // Focus falls back to activating the worktree alone; no pane is claimed on stale evidence.
    expect(target).toEqual({ worktreeId: 'wt-a', tabId: null, leafId: null })
  })
})
