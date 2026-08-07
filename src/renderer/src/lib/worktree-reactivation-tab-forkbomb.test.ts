import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { activateAndRevealWorktree, ensureWorktreeHasInitialTerminal } from './worktree-activation'
import { makeCreatedAgentWorktree as makeWorktree } from '@/lib/worktree-activation-created-agent-test-state'

vi.mock('../hooks/remote-workspace-snapshot-apply', () => ({
  isDirectSshRemoteWorkspaceApplyInProgress: vi.fn(() => false)
}))

const initialAppStoreState = useAppStore.getState()

function stubEmptyPartitions(): void {
  vi.stubGlobal('window', {
    api: { session: { get: vi.fn().mockResolvedValue({ tabsByWorktree: {} } as never) } }
  })
}

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
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

describe('STA-1111 worktree reopen does not fork-bomb tabs', () => {
  it('re-captured sleeping codex session resumes once, not once per reopen', async () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    useAppStore.setState(baseState(worktree))
    stubEmptyPartitions()
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
      await vi.waitFor(() => {
        expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(1)
        expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
      })

      const state = useAppStore.getState()
      const tabs = state.tabsByWorktree[worktree.id] ?? []

      expect(tabs).toHaveLength(1)
      resumedTabId ??= tabs[0]!.id
      expect(tabs[0]!.id).toBe(resumedTabId)
      expect(state.automaticAgentResumeClaimsByTabId[tabs[0]!.id]?.providerSession).toEqual(
        providerSession
      )

      if (reopen === 0) {
        expect(state.consumeTabStartupCommand(tabs[0]!.id)?.resumeProviderSession).toEqual(
          providerSession
        )
      }
    }
  })

  it('worktree still gets its initial terminal once a rescue declines to launch', async () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    useAppStore.setState(baseState(worktree))
    const wakeTabId = 'declined-wake-tab'
    vi.stubGlobal('window', {
      api: {
        session: {
          get: vi
            .fn()
            .mockResolvedValue({ tabsByWorktree: { [worktree.id]: [{ id: wakeTabId }] } } as never)
        }
      }
    })
    const paneKey = 'slept-pane-declined:0'
    useAppStore.setState((s) => ({
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        [paneKey]: {
          paneKey,
          tabId: wakeTabId,
          worktreeId: worktree.id,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-declined' },
          prompt: 'resume prior task',
          state: 'working',
          origin: 'live',
          capturedAt: 1000,
          updatedAt: 1000,
          terminalTitle: 'Codex'
        }
      }
    }))

    activateAndRevealWorktree(worktree.id)

    // The rescue finds the session's tab already alive in a persisted partition and declines to
    // launch a duplicate, leaving the worktree without a tab until the initial-terminal gate
    // re-evaluates.
    await vi.waitFor(() => {
      expect(
        useAppStore.getState().strandedSleepingAgentRescuesByWorktreeId[worktree.id] ?? 0
      ).toBe(0)
    })
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)

    const createdTabId = ensureWorktreeHasInitialTerminal(useAppStore.getState(), worktree.id)

    expect(createdTabId).toBeTruthy()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
  })

  it('queued issueCommand reaches the first tab once a pending rescue resolves', async () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    useAppStore.setState(baseState(worktree))
    stubEmptyPartitions()
    const paneKey = 'slept-pane-issue-command:0'
    useAppStore.setState((s) => ({
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        [paneKey]: {
          paneKey,
          tabId: 'slept-pane-issue-command',
          worktreeId: worktree.id,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-issue-command' },
          prompt: 'resume prior task',
          state: 'working',
          origin: 'live',
          capturedAt: 1000,
          updatedAt: 1000,
          terminalTitle: 'Codex'
        }
      }
    }))

    activateAndRevealWorktree(worktree.id, { issueCommand: { command: 'echo hi' } })

    // The rescue's ref-count increment is synchronous, so activation must not create a
    // placeholder tab (and drop the issueCommand) while the rescue is still in flight.
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)

    await vi.waitFor(() => {
      expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(1)
    })

    const firstTabId = useAppStore.getState().tabsByWorktree[worktree.id]![0]!.id
    await vi.waitFor(() => {
      expect(useAppStore.getState().pendingIssueCommandSplitByTabId[firstTabId]?.command).toBe(
        'echo hi'
      )
    })
  })

  it('startup payload creates its tab immediately despite a pending rescue, and the rescue does not remove it', async () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    useAppStore.setState(baseState(worktree))
    stubEmptyPartitions()
    const paneKey = 'slept-pane-startup:0'
    useAppStore.setState((s) => ({
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        [paneKey]: {
          paneKey,
          tabId: 'slept-pane-startup',
          worktreeId: worktree.id,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-startup' },
          prompt: 'resume prior task',
          state: 'working',
          origin: 'live',
          capturedAt: 1000,
          updatedAt: 1000,
          terminalTitle: 'Codex'
        }
      }
    }))

    activateAndRevealWorktree(worktree.id, { startup: { command: 'echo startup' } })

    // An explicit startup payload is a request for a specific tab, not a placeholder — it must
    // create immediately rather than wait on the concurrently pending rescue.
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(1)
    const startupTabId = useAppStore.getState().tabsByWorktree[worktree.id]![0]!.id

    await vi.waitFor(() => {
      expect(
        useAppStore.getState().strandedSleepingAgentRescuesByWorktreeId[worktree.id] ?? 0
      ).toBe(0)
    })

    const tabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? []
    expect(tabs.map((tab) => tab.id)).toContain(startupTabId)
  })
})
