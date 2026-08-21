import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { makeCreatedAgentWorktree as makeWorktree } from '@/lib/worktree-activation-created-agent-test-state'

const initialAppStoreState = useAppStore.getState()

function baseState(worktree: ReturnType<typeof makeWorktree>): Partial<AppState> {
  return {
    repos: [
      {
        id: 'repo-1',
        path: path.join(path.sep, 'workspace', 'repo'),
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
    automaticAgentResumeClaimsByTabId: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    settings: {
      agentCmdOverrides: {},
      setupScriptLaunchMode: 'new-tab'
    } as unknown as ReturnType<typeof useAppStore.getState>['settings'],
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  }
}

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('STA-1111 worktree reopen does not fork-bomb tabs', () => {
  it('re-captured sleeping codex session resumes once, not once per reopen', () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    useAppStore.setState(baseState(worktree))
    const providerSession = { key: 'session_id' as const, id: 'codex-session-1' }
    let resumedTabId: string | undefined

    for (let reopen = 0; reopen < 4; reopen++) {
      const paneKey = `slept-pane-${reopen}:0`
      useAppStore.setState((s) => ({
        sleepingAgentSessionsByPaneKey: {
          ...s.sleepingAgentSessionsByPaneKey,
          [paneKey]: {
            paneKey,
            tabId: `slept-pane-${reopen}`,
            worktreeId: worktree.id,
            agent: 'codex',
            providerSession,
            prompt: 'resume prior task',
            state: 'working',
            origin: 'live',
            capturedAt: 1000 + reopen,
            updatedAt: 1000 + reopen,
            terminalTitle: 'Codex'
          }
        }
      }))

      activateAndRevealWorktree(worktree.id)
      const state = useAppStore.getState()
      const tabs = state.tabsByWorktree[worktree.id] ?? []

      expect(tabs).toHaveLength(1)
      resumedTabId ??= tabs[0]!.id
      expect(tabs[0]!.id).toBe(resumedTabId)
      expect(state.automaticAgentResumeClaimsByTabId[tabs[0]!.id]?.providerSession).toEqual(
        providerSession
      )
      expect(state.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()

      if (reopen === 0) {
        expect(state.consumeTabStartupCommand(tabs[0]!.id)?.resumeProviderSession).toEqual(
          providerSession
        )
      }
    }
  })
})
