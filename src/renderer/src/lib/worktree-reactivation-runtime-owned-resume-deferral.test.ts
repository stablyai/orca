import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { makeCreatedAgentWorktree } from '@/lib/worktree-activation-created-agent-test-state'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { waitForWorktreeAgentActivationGateForTests } from './worktree-agent-activation-gate'

// Red repro for the aug20 "windows 2" incident (restart-reattach/resume-relaunch):
// a runtime-owned (paired remote) worktree's web-mirror tab holds a sleeping
// record for an agent whose host PTY is STILL ALIVE, but at activation time the
// client's mirror has not yet received the host snapshot (ptyIdsByTabId empty).
// Activation must NOT relaunch `codex resume <id>` — the original process holds
// the session (codex -32600 "already has an active writer") and the relaunch
// strands a bare shell while the live agent becomes a tab-less ghost.
//
// The resume fallback stays correct for LOCAL worktrees (control below).

const initialAppStoreState = useAppStore.getState()

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const WEB_TAB_ID = 'web-terminal-host-tab-1'
const RUNTIME_ENV_ID = 'env-abfee683'

function makeRuntimeOwnedWorktree(): ReturnType<typeof makeCreatedAgentWorktree> {
  const workspacePath = path.join(path.sep, 'workspace', 'feature')
  return {
    ...makeCreatedAgentWorktree(),
    id: `repo-1::${workspacePath}`,
    createdWithAgent: undefined,
    hostId: `runtime:${encodeURIComponent(RUNTIME_ENV_ID)}`
  }
}

function baseState(worktree: ReturnType<typeof makeCreatedAgentWorktree>): Partial<AppState> {
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
    tabsByWorktree: {
      [worktree.id]: [{ id: WEB_TAB_ID, title: 'Codex', ptyId: null } as never]
    },
    unifiedTabsByWorktree: {
      [worktree.id]: [
        {
          id: `unified-${WEB_TAB_ID}`,
          contentType: 'terminal',
          entityId: WEB_TAB_ID,
          groupId: 'group-1'
        } as never
      ]
    },
    groupsByWorktree: {
      [worktree.id]: [
        {
          id: 'group-1',
          activeTabId: `unified-${WEB_TAB_ID}`,
          tabOrder: [`unified-${WEB_TAB_ID}`],
          recentTabIds: []
        } as never
      ]
    },
    activeGroupIdByWorktree: { [worktree.id]: 'group-1' },
    layoutByWorktree: {},
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
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {
      [WEB_TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        // Persisted binding from before the host restart: the pane HAD a PTY.
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-host-old-1' }
      } as never
    },
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

function seedSleepingRecord(worktreeId: string, sessionId: string): string {
  const paneKey = makePaneKey(WEB_TAB_ID, LEAF_ID)
  useAppStore.setState((s) => ({
    sleepingAgentSessionsByPaneKey: {
      ...s.sleepingAgentSessionsByPaneKey,
      [paneKey]: {
        paneKey,
        tabId: WEB_TAB_ID,
        worktreeId,
        agent: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: sessionId },
        prompt: 'keep working',
        state: 'working' as const,
        // The incident record: captured live while the host agent was running.
        origin: 'live' as const,
        capturedAt: 1000,
        updatedAt: 1000,
        terminalTitle: 'Codex'
      }
    }
  }))
  return paneKey
}

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('runtime-owned worktree activation with an unhydrated host mirror', () => {
  it('does not relaunch a resume tab while remote PTY liveness is unknown', () => {
    const worktree = makeRuntimeOwnedWorktree()
    useAppStore.setState(baseState(worktree))
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-live-1')

    activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })

    const after = useAppStore.getState()
    const tabs = after.tabsByWorktree[worktree.id] ?? []
    // RED on main: a replacement `codex resume` tab is appended even though the
    // host PTY may be (and in the incident, was) alive.
    expect(tabs.map((tab) => tab.id)).toEqual([WEB_TAB_ID])
    // The record is the only recovery evidence; deferral must retain it.
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('control: still owns the pane (no relaunch) once the mirror reports the PTY live', () => {
    const worktree = makeRuntimeOwnedWorktree()
    const state = baseState(worktree)
    state.ptyIdsByTabId = { [WEB_TAB_ID]: ['pty-host-old-1'] }
    useAppStore.setState(state)
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-live-2')

    activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })

    const after = useAppStore.getState()
    expect((after.tabsByWorktree[worktree.id] ?? []).map((tab) => tab.id)).toEqual([WEB_TAB_ID])
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  it('control: a local worktree with a dead pane still gets the resume fallback', async () => {
    const worktree = {
      ...makeCreatedAgentWorktree(),
      createdWithAgent: undefined,
      hostId: 'local' as const
    }
    const state = baseState(worktree)
    state.activeWorkspaceExecutionHostId = null
    state.workspaceSessionReady = true
    state.terminalStartupRestorationReady = true
    // Local husk tab: same shape, non-mirror tab id.
    const localTabId = 'husk-tab-1'
    state.tabsByWorktree = {
      [worktree.id]: [{ id: localTabId, title: 'Codex', ptyId: null } as never]
    }
    state.unifiedTabsByWorktree = {
      [worktree.id]: [
        {
          id: `unified-${localTabId}`,
          contentType: 'terminal',
          entityId: localTabId,
          groupId: 'group-1'
        } as never
      ]
    }
    state.groupsByWorktree = {
      [worktree.id]: [
        {
          id: 'group-1',
          activeTabId: `unified-${localTabId}`,
          tabOrder: [`unified-${localTabId}`],
          recentTabIds: []
        } as never
      ]
    }
    state.terminalLayoutsByTabId = {
      [localTabId]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID
      } as never
    }
    useAppStore.setState(state)
    const paneKey = makePaneKey(localTabId, LEAF_ID)
    useAppStore.setState((s) => ({
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        [paneKey]: {
          paneKey,
          tabId: localTabId,
          worktreeId: worktree.id,
          agent: 'codex' as const,
          providerSession: { key: 'session_id' as const, id: 'codex-session-dead-1' },
          prompt: 'resume prior task',
          state: 'working' as const,
          origin: 'quit' as const,
          capturedAt: 1000,
          updatedAt: 1000,
          terminalTitle: 'Codex'
        }
      }
    }))

    activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })
    await waitForWorktreeAgentActivationGateForTests(worktree.id)

    const after = useAppStore.getState()
    const tabs = after.tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(2)
    const replacement = tabs.find((tab) => tab.id !== localTabId)!
    expect(after.automaticAgentResumeClaimsByTabId[replacement.id]?.providerSession).toEqual({
      key: 'session_id',
      id: 'codex-session-dead-1'
    })
  })
})
