import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import {
  buildUnreadAgentJumpThreads,
  orderUnreadAgentJumpTargets,
  resolveUnreadAgentJumpTargets
} from './activity-unread-agent-jump'
import {
  makeRepo,
  makeTabWithIds,
  makeWorktree,
  PANE_KEY,
  PANE_KEY_2,
  PANE_KEY_3
} from './ActivityPrototypePage-test-fixtures'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))

const NOW = 10_000_000

type JumpSource = Parameters<typeof buildUnreadAgentJumpThreads>[0] &
  Pick<
    AppState,
    | 'terminalLayoutsByTabId'
    | 'detectedWorktreesByRepo'
    | 'folderWorkspaces'
    | 'floatingWorkspacePath'
    | 'settings'
  >

function makeJumpSource(entries: AgentStatusEntry[]): JumpSource {
  const repo = makeRepo()
  const worktree = makeWorktree()
  return {
    agentStatusByPaneKey: Object.fromEntries(entries.map((e) => [e.paneKey, e])),
    runtimeAgentOrchestrationByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {},
    tabsByWorktree: {
      [worktree.id]: ['tab-1', 'tab-2', 'tab-3'].map((id) => makeTabWithIds(id, worktree.id))
    },
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {},
    worktreesByRepo: { [repo.id]: [worktree] },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    floatingWorkspacePath: null,
    settings: null,
    repos: [repo],
    getKnownWorktreeById: (id) => (id === worktree.id ? worktree : undefined),
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    agentsShowChildAgents: false
  }
}

function entry(
  paneKey: string,
  state: AgentStatusEntry['state'],
  stateStartedAt: number,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: NOW,
    stateStartedAt,
    paneKey,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

function pick(
  entries: AgentStatusEntry[],
  direction: 'next' | 'previous',
  options: {
    acks?: Record<string, number>
    canOpen?: (paneKey: string) => boolean
    showChildAgents?: boolean
  } = {}
): string[] {
  const acks = options.acks ?? {}
  const source = makeJumpSource(entries)
  source.acknowledgedAgentsByPaneKey = acks
  source.agentsShowChildAgents = options.showChildAgents ?? false
  // Why the real thread builder: the shortcut must agree with what the Activity list marks unread.
  const threads = buildUnreadAgentJumpThreads(source, NOW)
  return orderUnreadAgentJumpTargets(threads, acks, direction, (thread) =>
    options.canOpen ? options.canOpen(thread.paneKey) : true
  ).map((thread) => thread.paneKey)
}

describe('unread agent jump order', () => {
  it('opens an agent that needs input before an older unread finished turn', () => {
    const entries = [entry(PANE_KEY, 'done', NOW - 9_000), entry(PANE_KEY_2, 'waiting', NOW - 100)]

    expect(pick(entries, 'next')[0]).toBe(PANE_KEY_2)
    expect(pick(entries, 'previous')[0]).toBe(PANE_KEY_2)
  })

  it('keeps a question unanswered past the freshness window in the needs-input tier', () => {
    const staleAt = NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000
    const entries = [
      entry(PANE_KEY, 'blocked', staleAt, { updatedAt: staleAt }),
      entry(PANE_KEY_2, 'done', NOW - 100)
    ]

    expect(pick(entries, 'previous')).toEqual([PANE_KEY, PANE_KEY_2])
  })

  it('goes to the longest wait on next and the newest on previous', () => {
    const entries = [entry(PANE_KEY, 'done', NOW - 9_000), entry(PANE_KEY_2, 'done', NOW - 100)]

    expect(pick(entries, 'next')).toEqual([PANE_KEY, PANE_KEY_2])
    expect(pick(entries, 'previous')).toEqual([PANE_KEY_2, PANE_KEY])
  })

  it('skips agents already read and agents still working', () => {
    const entries = [
      entry(PANE_KEY, 'done', NOW - 9_000),
      entry(PANE_KEY_2, 'working', NOW - 8_000),
      entry(PANE_KEY_3, 'done', NOW - 100)
    ]

    expect(pick(entries, 'next', { acks: { [PANE_KEY]: NOW - 5_000 } })).toEqual([PANE_KEY_3])
  })

  it('drains waiting agents one at a time without acknowledging their siblings', () => {
    const entries = [
      entry(PANE_KEY, 'waiting', NOW - 9_000),
      entry(PANE_KEY_2, 'blocked', NOW - 100)
    ]

    expect(pick(entries, 'next')).toEqual([PANE_KEY, PANE_KEY_2])
    expect(pick(entries, 'next', { acks: { [PANE_KEY]: NOW } })).toEqual([PANE_KEY_2])
    expect(pick(entries, 'next', { acks: { [PANE_KEY]: NOW, [PANE_KEY_2]: NOW } })).toEqual([])
  })

  it('treats a main agent that finished under a background shell as unread until visited', () => {
    const monitoring = entry(PANE_KEY, 'working', NOW - 9_000, {
      workingMode: 'monitoring',
      mainAgent: { state: 'done', stateStartedAt: NOW - 500 }
    })

    expect(pick([monitoring], 'next')).toEqual([PANE_KEY])
    expect(pick([monitoring], 'next', { acks: { [PANE_KEY]: NOW - 100 } })).toEqual([])
  })

  it('drops an agent whose pane can no longer be opened instead of stopping on it', () => {
    const entries = [entry(PANE_KEY, 'done', NOW - 9_000), entry(PANE_KEY_2, 'done', NOW - 100)]

    expect(pick(entries, 'next', { canOpen: (paneKey) => paneKey !== PANE_KEY })).toEqual([
      PANE_KEY_2
    ])
  })

  it('leaves child agents out unless the Agents list shows them', () => {
    const entries = [
      entry(PANE_KEY, 'working', NOW - 9_000),
      entry(PANE_KEY_2, 'done', NOW - 100, {
        orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-1', dispatchId: 'ctx-1' }
      })
    ]

    expect(pick(entries, 'next')).toEqual([])
    expect(pick(entries, 'next', { showChildAgents: true })).toEqual([PANE_KEY_2])
  })

  it('returns nothing when no agent is unread so the chord reaches the terminal', () => {
    expect(pick([entry(PANE_KEY, 'working', NOW - 100)], 'next')).toEqual([])
  })
})

describe('unread agent jump reachability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns no target for a retained closed floating terminal so the key can pass through', () => {
    const source = makeJumpSource([])
    const worktree = { ...makeWorktree(), id: FLOATING_TERMINAL_WORKTREE_ID }
    const tab = makeTabWithIds('tab-1', worktree.id)
    source.worktreesByRepo = { [worktree.repoId]: [worktree] }
    source.tabsByWorktree = {}
    source.retainedAgentsByPaneKey = {
      [PANE_KEY]: {
        entry: entry(PANE_KEY, 'done', NOW - 100),
        worktreeId: worktree.id,
        tab,
        agentType: 'claude',
        startedAt: NOW - 100
      }
    }
    mocks.getState.mockReturnValue(source)

    expect(resolveUnreadAgentJumpTargets('next')).toEqual([])
    expect(resolveUnreadAgentJumpTargets('previous')).toEqual([])
  })

  it('excludes a closed split pane while retaining the next unread agent', () => {
    const source = makeJumpSource([
      entry(PANE_KEY, 'done', NOW - 9_000),
      entry(PANE_KEY_2, 'done', NOW - 100)
    ])
    source.terminalLayoutsByTabId = {
      'tab-1': {
        root: { type: 'leaf', leafId: '33333333-3333-4333-8333-333333333333' },
        activeLeafId: '33333333-3333-4333-8333-333333333333',
        expandedLeafId: null
      }
    }
    mocks.getState.mockReturnValue(source)

    expect(resolveUnreadAgentJumpTargets('next').map((thread) => thread.paneKey)).toEqual([
      PANE_KEY_2
    ])
  })

  it('keeps a resident terminal eligible when its layout has not mounted yet', () => {
    const source = makeJumpSource([entry(PANE_KEY, 'done', NOW - 100)])
    mocks.getState.mockReturnValue(source)

    expect(resolveUnreadAgentJumpTargets('next').map((thread) => thread.paneKey)).toEqual([
      PANE_KEY
    ])
  })
})
