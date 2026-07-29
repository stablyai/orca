// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { GlobalSettings, Repo, TerminalTab, Worktree } from '../../../../shared/types'
import { useLiveDashboardSnapshot } from './useLiveDashboardSnapshot'

const NOW = 1_000_000_000
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

const initialAppState = useAppStore.getInitialState()

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
})

afterEach(() => {
  useAppStore.setState(initialAppState, true)
})

function repo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo One',
    badgeColor: '#000',
    repoIcon: { type: 'lucide', name: 'Rocket' },
    addedAt: 1
  }
}

function worktree(): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt-1',
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'wt-one',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: NOW
  }
}

function tab(): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'agent',
    customTitle: null,
    generatedTitle: 'Fix the flaky pty test',
    color: null,
    sortOrder: 0,
    createdAt: NOW
  } as TerminalTab
}

function entry(): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'do the thing',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    stateHistory: [],
    agentType: 'claude',
    tabId: TAB_ID,
    worktreeId: 'wt-1'
  }
}

function seed(settings: Partial<GlobalSettings> | null): void {
  useAppStore.setState({
    repos: [repo()],
    worktreesByRepo: { 'repo-1': [worktree()] },
    tabsByWorktree: { 'wt-1': [tab()] },
    agentStatusByPaneKey: { [PANE_KEY]: entry() },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
    settings: settings as GlobalSettings | null
  })
}

// Why: the in-window drawer derives its own snapshot instead of receiving the
// relayed one, so anything the builder reads has to be threaded in by hand —
// a dropped slice silently blanks the field rather than failing loudly.
describe('useLiveDashboardSnapshot', () => {
  it('feeds the builder the settings that gate generated conversation names', () => {
    seed({ tabAutoGenerateTitle: true })
    const withTitles = renderHook(() => useLiveDashboardSnapshot())
    expect(withTitles.result.current.cards[0].conversationName).toBe('Fix the flaky pty test')

    seed({ tabAutoGenerateTitle: false })
    const withoutTitles = renderHook(() => useLiveDashboardSnapshot())
    expect(withoutTitles.result.current.cards[0].conversationName).toBeUndefined()
  })

  it('carries repo icons through to the drawer', () => {
    seed({ tabAutoGenerateTitle: false })
    const { result } = renderHook(() => useLiveDashboardSnapshot())
    expect(result.current.repoIconsByRepoId).toEqual({
      'repo-1': { type: 'lucide', name: 'Rocket' }
    })
  })
})
