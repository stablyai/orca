// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  makeRepo,
  makeTerminalTab,
  makeWorktree
} from '../../../worktree-jump-palette-test-fixtures'
import { useSidebarWorktreeSortOrder } from './use-sort-order'

vi.mock('@/lib/worktree-sort-order-persistence', () => ({
  persistWorktreeSortOrderByHost: vi.fn()
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

const initialState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function agentEntry(
  tabId: string,
  worktreeId: string,
  state: AgentStatusEntry['state'],
  at: number
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: at,
    stateStartedAt: at,
    agentType: 'codex',
    paneKey: makePaneKey(tabId, LEAF_ID),
    worktreeId,
    tabId,
    stateHistory: []
  }
}

type Fixture = {
  worktrees: Worktree[]
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId: Record<string, string[]>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
}

/**
 * Three Done workspaces and two In progress ones:
 * - `done-stale`: untouched for 30 days, but its terminal still holds a PTY whose
 *   agent stopped reporting 3 days ago (Class 4 "unverifiable" attention).
 * - `done-recent`: no agent; last PTY activity 1 hour ago.
 * - `done-agent`: last PTY activity 10 days ago, but its agent finished 40 minutes
 *   ago while the workspace was selected (no PTY bump, completion already aged out of Class 2).
 */
function buildFixture(now: number): Fixture {
  const worktrees = [
    makeWorktree('done-stale', 'done-stale', {
      workspaceStatus: 'completed',
      lastActivityAt: now - 30 * DAY
    }),
    makeWorktree('done-recent', 'done-recent', {
      workspaceStatus: 'completed',
      lastActivityAt: now - HOUR
    }),
    makeWorktree('done-agent', 'done-agent', {
      workspaceStatus: 'completed',
      lastActivityAt: now - 10 * DAY
    }),
    makeWorktree('wip-stale', 'wip-stale', {
      workspaceStatus: 'in-progress',
      lastActivityAt: now - 30 * DAY
    }),
    makeWorktree('wip-recent', 'wip-recent', {
      workspaceStatus: 'in-progress',
      lastActivityAt: now - HOUR
    })
  ]
  const tabs = {
    'done-stale': makeTerminalTab('tab-done-stale', 'done-stale', 'codex'),
    'done-agent': makeTerminalTab('tab-done-agent', 'done-agent', 'codex'),
    'wip-stale': makeTerminalTab('tab-wip-stale', 'wip-stale', 'codex')
  }
  const entries = [
    agentEntry('tab-done-stale', 'done-stale', 'working', now - 3 * DAY),
    agentEntry('tab-done-agent', 'done-agent', 'done', now - 40 * MINUTE),
    agentEntry('tab-wip-stale', 'wip-stale', 'working', now - 3 * DAY)
  ]
  return {
    worktrees,
    tabsByWorktree: Object.fromEntries(
      Object.entries(tabs).map(([worktreeId, tab]) => [worktreeId, [tab]])
    ),
    ptyIdsByTabId: Object.fromEntries(
      Object.values(tabs).map((tab) => [tab.id, [`pty-${tab.id}`]])
    ),
    agentStatusByPaneKey: Object.fromEntries(entries.map((entry) => [entry.paneKey, entry]))
  }
}

function seedStore(fixture: Fixture, overrides: Partial<ReturnType<typeof useAppStore.getState>>) {
  const repo = makeRepo()
  useAppStore.setState({
    worktreesByRepo: { [repo.id]: fixture.worktrees },
    tabsByWorktree: fixture.tabsByWorktree,
    ptyIdsByTabId: fixture.ptyIdsByTabId,
    agentStatusByPaneKey: fixture.agentStatusByPaneKey,
    activeWorktreeId: 'done-agent',
    ...overrides
  })
  return new Map([[repo.id, repo]])
}

function onlyIds(sortedIds: readonly string[], ids: readonly string[]): string[] {
  return sortedIds.filter((id) => ids.includes(id))
}

const DONE_IDS = ['done-stale', 'done-recent', 'done-agent']
const IN_PROGRESS_IDS = ['wip-stale', 'wip-recent']

describe('useSidebarWorktreeSortOrder — agent activity and status lanes', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('Recent counts agent starts and completions, including in the selected workspace', () => {
    const fixture = buildFixture(Date.now())
    const repoMap = seedStore(fixture, { groupBy: 'workspace-status' })

    const { result } = renderHook(() =>
      useSidebarWorktreeSortOrder({ allWorktrees: fixture.worktrees, repoMap, sortBy: 'recent' })
    )

    expect(onlyIds(result.current, DONE_IDS)).toEqual(['done-agent', 'done-recent', 'done-stale'])
  })

  it('orders the Done lane by recent activity under Agent Activity, keeping attention priority elsewhere', () => {
    const fixture = buildFixture(Date.now())
    const repoMap = seedStore(fixture, { groupBy: 'workspace-status' })

    const { result } = renderHook(() =>
      useSidebarWorktreeSortOrder({ allWorktrees: fixture.worktrees, repoMap, sortBy: 'smart' })
    )

    expect(onlyIds(result.current, DONE_IDS)).toEqual(['done-agent', 'done-recent', 'done-stale'])
    // Why: only Done drops attention priority; the unverifiable agent still leads In progress.
    expect(onlyIds(result.current, IN_PROGRESS_IDS)).toEqual(['wip-stale', 'wip-recent'])
  })

  it('re-sorts when status grouping is turned on without waiting for another sort trigger', () => {
    const fixture = buildFixture(Date.now())
    const repoMap = seedStore(fixture, { groupBy: 'none' })

    const { result } = renderHook(() =>
      useSidebarWorktreeSortOrder({ allWorktrees: fixture.worktrees, repoMap, sortBy: 'smart' })
    )
    // Why: without status lanes Agent Activity keeps its attention classes everywhere.
    expect(onlyIds(result.current, DONE_IDS)[0]).toBe('done-stale')

    act(() => {
      useAppStore.setState({ groupBy: 'workspace-status' })
    })

    expect(onlyIds(result.current, DONE_IDS)).toEqual(['done-agent', 'done-recent', 'done-stale'])
  })
})
