import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { waitForWorktreeAgentActivationGateForTests } from './worktree-agent-activation-gate'
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
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
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
  it('defers packaged-startup resume until restored PTYs finish reconnecting', async () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    useAppStore.setState({
      ...baseState(worktree),
      workspaceSessionReady: false,
      terminalStartupRestorationReady: false
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `packaged-restart-pane:${leafId}`
    const livePtyId = `${worktree.id}@@daemon-live`
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'packaged-restart-pane',
          worktreeId: worktree.id,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'packaged-session' },
          prompt: 'resume prior task',
          state: 'working',
          origin: 'quit',
          capturedAt: 1000,
          updatedAt: 1000,
          terminalTitle: 'Codex'
        }
      },
      terminalLayoutsByTabId: {
        'packaged-restart-pane': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: livePtyId }
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: vi.fn(async () => ({ ok: true, result: { snapshots: [] } }))
        },
        pty: {
          listSessions: vi.fn(async () => [
            {
              id: livePtyId,
              cwd: worktree.path,
              title: 'Codex',
              agentOwnership: 'present' as const
            }
          ])
        }
      }
    })

    activateAndRevealWorktree(worktree.id)
    const gate = waitForWorktreeAgentActivationGateForTests(worktree.id)
    await Promise.resolve()
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)

    useAppStore.setState({
      workspaceSessionReady: true,
      terminalStartupRestorationReady: true
    })
    await gate
    const restored = useAppStore.getState()
    expect(restored.tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(restored.tabsByWorktree[worktree.id]?.[0]?.ptyId).toBe(livePtyId)
    expect(restored.automaticAgentResumeClaimsByTabId).toEqual({})
    expect(restored.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  it('re-captured sleeping codex session resumes once, not once per reopen', async () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    useAppStore.setState(baseState(worktree))
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: vi.fn(async () => ({ ok: true, result: { snapshots: [] } }))
        },
        pty: { listSessions: vi.fn(async () => []) }
      }
    })
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
      await waitForWorktreeAgentActivationGateForTests(worktree.id)
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
