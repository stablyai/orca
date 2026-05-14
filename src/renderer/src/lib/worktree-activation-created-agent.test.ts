import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/types'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeWorktree(): Worktree {
  return {
    id: 'repo-1::/workspace/feature',
    repoId: 'repo-1',
    path: '/workspace/feature',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdWithAgent: 'codex'
  }
}

describe('activateAndRevealWorktree created agent reopen', () => {
  it('reopens an empty worktree with the agent selected at creation time', () => {
    const worktree = makeWorktree()

    useAppStore.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/workspace/repo',
          displayName: 'repo',
          badgeColor: '#000000',
          addedAt: 0
        }
      ],
      worktreesByRepo: { 'repo-1': [worktree] },
      activeRepoId: 'repo-1',
      activeView: 'terminal',
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {},
      activeFileIdByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      activeTabTypeByWorktree: {},
      activeTabIdByWorktree: {},
      tabBarOrderByWorktree: {},
      pendingStartupByTabId: {},
      settings: {
        agentCmdOverrides: {},
        setupScriptLaunchMode: 'new-tab'
      } as unknown as ReturnType<typeof useAppStore.getState>['settings'],
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn(),
      revealWorktreeInSidebar: vi.fn()
    })

    const result = activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[worktree.id]?.[0]

    expect(result).toEqual({ primaryTabId: reopenedTab?.id })
    expect(reopenedTab).toBeDefined()
    expect(state.pendingStartupByTabId[reopenedTab!.id]).toEqual({
      command: 'codex',
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'sidebar',
        request_kind: 'resume'
      }
    })
  })
})
