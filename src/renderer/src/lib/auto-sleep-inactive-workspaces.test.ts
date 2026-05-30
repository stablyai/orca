import { describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../shared/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import {
  collectAutoSleepWorktreeIds,
  type AutoSleepInactiveWorkspacesState
} from './auto-sleep-inactive-workspaces'

vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({
  isPtyLocked: vi.fn(() => false)
}))

import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'

const NOW = 1_700_000_000_000

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#000',
    addedAt: 1,
    autoSleepInactiveWorkspacesAfterMs: 30 * 60_000,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::wt-a',
    repoId: 'repo-1',
    path: '/repo/wt-a',
    branch: 'feature/a',
    displayName: 'wt-a',
    isMainWorktree: false,
    isPinned: false,
    isUnread: false,
    lastActivityAt: NOW,
    ...overrides
  } as Worktree
}

function makeState(
  overrides: Partial<AutoSleepInactiveWorkspacesState> = {}
): AutoSleepInactiveWorkspacesState {
  const worktree = makeWorktree()
  return {
    activeWorktreeId: null,
    worktreesByRepo: { 'repo-1': [worktree] },
    repos: [makeRepo()],
    tabsByWorktree: {
      [worktree.id]: [{ id: 'tab-1', title: 'shell' }]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    browserTabsByWorktree: {},
    lastVisitedAtByWorktreeId: {
      [worktree.id]: NOW - 31 * 60_000
    },
    agentStatusByPaneKey: {},
    runtimePaneTitlesByTabId: {},
    openFiles: [],
    editorDrafts: {},
    sshConnectionStates: new Map(),
    ...overrides
  }
}

describe('collectAutoSleepWorktreeIds', () => {
  it('sleeps an eligible background workspace when the repo policy is enabled', () => {
    const state = makeState()
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual(['repo-1::wt-a'])
  })

  it('skips repos with auto-sleep disabled', () => {
    const state = makeState({
      repos: [makeRepo({ autoSleepInactiveWorkspacesAfterMs: null })]
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual([])
  })

  it('skips workspaces visited within the inactivity window', () => {
    const worktree = makeWorktree()
    const state = makeState({
      lastVisitedAtByWorktreeId: {
        [worktree.id]: NOW - 5 * 60_000
      }
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual([])
  })

  it('skips workspaces that were never visited', () => {
    const state = makeState({
      lastVisitedAtByWorktreeId: {}
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual([])
  })

  it('skips the active workspace', () => {
    const worktree = makeWorktree()
    const state = makeState({
      activeWorktreeId: worktree.id
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual([])
  })

  it('skips pinned workspaces', () => {
    const state = makeState({
      worktreesByRepo: {
        'repo-1': [makeWorktree({ isPinned: true })]
      }
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual([])
  })

  it('skips already-slept workspaces without live resources', () => {
    const worktree = makeWorktree()
    const state = makeState({
      tabsByWorktree: { [worktree.id]: [{ id: 'tab-1', title: 'shell' }] },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual([])
  })

  it('skips workspaces with a fresh working agent', () => {
    const entry: AgentStatusEntry = {
      paneKey: 'tab-1:0',
      state: 'working',
      prompt: '',
      updatedAt: NOW - 1_000,
      stateStartedAt: NOW - 1_000,
      stateHistory: [],
      agentType: 'claude'
    }
    const state = makeState({
      agentStatusByPaneKey: { 'tab-1:0': entry }
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual([])
  })

  it('skips workspaces with title-derived working agents', () => {
    const worktree = makeWorktree()
    const state = makeState({
      tabsByWorktree: {
        [worktree.id]: [{ id: 'tab-1', title: 'Claude working' }]
      }
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual([])
  })

  it('allows sleep when agent status is stale', () => {
    const worktree = makeWorktree()
    const entry: AgentStatusEntry = {
      paneKey: 'tab-1:0',
      state: 'working',
      prompt: '',
      updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
      stateStartedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
      stateHistory: [],
      agentType: 'claude'
    }
    const state = makeState({
      agentStatusByPaneKey: { 'tab-1:0': entry }
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual([worktree.id])
  })

  it('skips workspaces with dirty editor buffers', () => {
    const worktree = makeWorktree()
    const state = makeState({
      openFiles: [{ id: 'file-1', worktreeId: worktree.id, isDirty: true }]
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual([])
  })

  it('skips SSH-backed repos when disconnected', () => {
    const state = makeState({
      repos: [
        makeRepo({
          connectionId: 'ssh-1',
          autoSleepInactiveWorkspacesAfterMs: 30 * 60_000
        })
      ],
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'disconnected',
            error: null,
            reconnectAttempt: 0
          }
        ]
      ])
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual([])
  })

  it('skips workspaces with a mobile-locked PTY', () => {
    vi.mocked(isPtyLocked).mockReturnValueOnce(true)
    expect(collectAutoSleepWorktreeIds(makeState(), NOW)).toEqual([])
  })

  it('evaluates repos independently with different policies', () => {
    const wtA = makeWorktree({ id: 'repo-1::wt-a', repoId: 'repo-1' })
    const wtB = makeWorktree({ id: 'repo-2::wt-b', repoId: 'repo-2' })
    const state = makeState({
      repos: [
        makeRepo({ id: 'repo-1', autoSleepInactiveWorkspacesAfterMs: 30 * 60_000 }),
        makeRepo({ id: 'repo-2', autoSleepInactiveWorkspacesAfterMs: null })
      ],
      worktreesByRepo: {
        'repo-1': [wtA],
        'repo-2': [wtB]
      },
      tabsByWorktree: {
        [wtA.id]: [{ id: 'tab-a', title: 'a' }],
        [wtB.id]: [{ id: 'tab-b', title: 'b' }]
      },
      ptyIdsByTabId: {
        'tab-a': ['pty-a'],
        'tab-b': ['pty-b']
      },
      lastVisitedAtByWorktreeId: {
        [wtA.id]: NOW - 31 * 60_000,
        [wtB.id]: NOW - 31 * 60_000
      }
    })
    expect(collectAutoSleepWorktreeIds(state, NOW)).toEqual(['repo-1::wt-a'])
  })
})
