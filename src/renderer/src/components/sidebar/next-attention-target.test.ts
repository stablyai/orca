import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  getState: vi.fn(() => ({ tabsByWorktree: {} }))
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import {
  focusAttentionTarget,
  listAttentionPanes,
  pickNextAttentionTarget,
  pickNextAttentionWorktree,
  resolveFocusedAttentionPaneKey
} from './next-attention-target'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { WorktreeAttention } from './smart-attention'

const NOW = new Date('2026-09-19T12:00:00.000Z').getTime()
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'

function waiting(attentionTimestamp: number): WorktreeAttention {
  return { cls: 1, attentionTimestamp, cause: 'waiting' }
}

function makeEntry(overrides: Partial<AgentStatusEntry> & { paneKey: string }): AgentStatusEntry {
  return {
    state: 'waiting',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    agentType: 'claude',
    stateHistory: [],
    ...overrides
  }
}

function byPaneKey(entries: AgentStatusEntry[]): Record<string, AgentStatusEntry> {
  return Object.fromEntries(entries.map((entry) => [entry.paneKey, entry]))
}

describe('pickNextAttentionWorktree', () => {
  it('returns null when no worktree needs input', () => {
    const attention = new Map<string, WorktreeAttention>([
      ['wt-working', { cls: 3, attentionTimestamp: NOW }],
      ['wt-done', { cls: 2, attentionTimestamp: NOW }]
    ])

    expect(pickNextAttentionWorktree(attention, null)).toBeNull()
  })

  it('starts at the most recent waiting worktree when the active one is not waiting', () => {
    const attention = new Map<string, WorktreeAttention>([
      ['wt-old', waiting(NOW - 5_000)],
      ['wt-new', waiting(NOW - 1_000)],
      ['wt-idle', { cls: 5, attentionTimestamp: 0 }]
    ])

    expect(pickNextAttentionWorktree(attention, 'wt-idle')).toBe('wt-new')
  })

  it('walks every waiting worktree in turn and wraps around', () => {
    const attention = new Map<string, WorktreeAttention>([
      ['wt-a', waiting(NOW - 1_000)],
      ['wt-b', waiting(NOW - 2_000)],
      ['wt-c', waiting(NOW - 3_000)]
    ])

    expect(pickNextAttentionWorktree(attention, 'wt-a')).toBe('wt-b')
    expect(pickNextAttentionWorktree(attention, 'wt-b')).toBe('wt-c')
    expect(pickNextAttentionWorktree(attention, 'wt-c')).toBe('wt-a')
  })

  it('keeps the only waiting worktree reachable while it is already active', () => {
    const attention = new Map<string, WorktreeAttention>([['wt-a', waiting(NOW)]])

    expect(pickNextAttentionWorktree(attention, 'wt-a')).toBe('wt-a')
  })
})

describe('listAttentionPanes', () => {
  it('lists waiting and blocked panes on tabs the worktree owns, freshest first', () => {
    const entries = byPaneKey([
      makeEntry({ paneKey: `tab-1:${LEAF_1}`, state: 'blocked', stateStartedAt: NOW - 4_000 }),
      makeEntry({ paneKey: `tab-1:${LEAF_2}`, stateStartedAt: NOW - 1_000 }),
      makeEntry({ paneKey: `tab-2:${LEAF_1}`, state: 'working', stateStartedAt: NOW })
    ])

    expect(listAttentionPanes(new Set(['tab-1', 'tab-2']), entries, NOW)).toEqual([
      { paneKey: `tab-1:${LEAF_2}`, tabId: 'tab-1', leafId: LEAF_2 },
      { paneKey: `tab-1:${LEAF_1}`, tabId: 'tab-1', leafId: LEAF_1 }
    ])
  })

  it('refuses a pane on another worktree tab even when the row is stamped for this one', () => {
    const entries = byPaneKey([
      makeEntry({ paneKey: `tab-own:${LEAF_1}`, worktreeId: 'wt-a', stateStartedAt: NOW - 5_000 }),
      makeEntry({ paneKey: `tab-foreign:${LEAF_2}`, worktreeId: 'wt-a', stateStartedAt: NOW })
    ])

    expect(
      listAttentionPanes(new Set(['tab-own']), entries, NOW).map((pane) => pane.tabId)
    ).toEqual(['tab-own'])
  })

  it('skips stale, malformed and non-finite rows instead of guessing a pane', () => {
    const entries = byPaneKey([
      makeEntry({
        paneKey: `tab-1:${LEAF_1}`,
        updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
        stateStartedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
      }),
      makeEntry({ paneKey: 'tab-1:7' }),
      makeEntry({ paneKey: `tab-1:${LEAF_2}`, stateStartedAt: Number.NaN })
    ])

    expect(listAttentionPanes(new Set(['tab-1']), entries, NOW)).toEqual([])
  })
})

describe('pickNextAttentionTarget', () => {
  const twoWaitingPanes = byPaneKey([
    makeEntry({ paneKey: `tab-a:${LEAF_1}`, stateStartedAt: NOW - 1_000 }),
    makeEntry({ paneKey: `tab-a:${LEAF_2}`, stateStartedAt: NOW - 2_000 }),
    makeEntry({ paneKey: `tab-b:${LEAF_1}`, stateStartedAt: NOW - 3_000 })
  ])
  const ownedTabIds = (worktreeId: string) => new Set([worktreeId === 'wt-a' ? 'tab-a' : 'tab-b'])
  const attentionByWorktree = new Map<string, WorktreeAttention>([
    ['wt-a', waiting(NOW - 1_000)],
    ['wt-b', waiting(NOW - 3_000)]
  ])
  const pick = (activeWorktreeId: string | null, focusedPaneKey: string | null) =>
    pickNextAttentionTarget({
      attentionByWorktree,
      activeWorktreeId,
      focusedPaneKey,
      ownedTabIds,
      agentStatusByPaneKey: twoWaitingPanes,
      now: NOW
    })?.pane?.paneKey

  it('walks every waiting agent in the active worktree before moving to the next worktree', () => {
    expect(pick(null, null)).toBe(`tab-a:${LEAF_1}`)
    expect(pick('wt-a', `tab-a:${LEAF_1}`)).toBe(`tab-a:${LEAF_2}`)
    expect(pick('wt-a', `tab-a:${LEAF_2}`)).toBe(`tab-b:${LEAF_1}`)
    expect(pick('wt-b', `tab-b:${LEAF_1}`)).toBe(`tab-a:${LEAF_1}`)
  })

  it('lands on the waiting agent of the active worktree when focus is on another pane', () => {
    expect(pick('wt-b', null)).toBe(`tab-b:${LEAF_1}`)
  })

  it('returns null when no agent needs input', () => {
    expect(
      pickNextAttentionTarget({
        attentionByWorktree: new Map([['wt-a', { cls: 3, attentionTimestamp: NOW }]]),
        activeWorktreeId: 'wt-a',
        focusedPaneKey: null,
        ownedTabIds,
        agentStatusByPaneKey: {},
        now: NOW
      })
    ).toBeNull()
  })
})

describe('focusAttentionTarget', () => {
  it('activates a host-qualified worktree on its own execution host', () => {
    focusAttentionTarget({ worktreeId: 'wt-remote', pane: null, executionHostId: 'ssh:devbox' })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-remote', {
      executionHostId: 'ssh:devbox'
    })
  })
})

describe('resolveFocusedAttentionPaneKey', () => {
  const chatTab: Tab = {
    id: 'chat-tab',
    entityId: 'session-1',
    groupId: 'group-1',
    worktreeId: 'wt-a',
    contentType: 'agent-session',
    label: 'Claude',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const chatPaneKey = structuredAgentSessionPaneKey(chatTab.id, chatTab.entityId)
  const focusedState = {
    activeWorktreeId: 'wt-a',
    activeTabType: 'agent-session' as const,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    getActiveTab: () => chatTab
  }

  it('keys a focused structured chat tab so repeated presses advance past it', () => {
    const focusedPaneKey = resolveFocusedAttentionPaneKey(focusedState)
    expect(focusedPaneKey).toBe(chatPaneKey)

    const next = pickNextAttentionTarget({
      attentionByWorktree: new Map([['wt-a', waiting(NOW)]]),
      activeWorktreeId: 'wt-a',
      focusedPaneKey,
      ownedTabIds: () => new Set([chatTab.id, 'tab-term']),
      agentStatusByPaneKey: byPaneKey([
        makeEntry({ paneKey: chatPaneKey, stateStartedAt: NOW }),
        makeEntry({ paneKey: `tab-term:${LEAF_1}`, stateStartedAt: NOW - 1_000 })
      ]),
      now: NOW
    })
    expect(next?.pane?.paneKey).toBe(`tab-term:${LEAF_1}`)
  })
})
