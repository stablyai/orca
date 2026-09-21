import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { makeCreatedAgentWorktree } from '@/lib/worktree-activation-created-agent-test-state'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  hasHostSessionMirrorHydrated,
  markHostSessionMirrorHydrated,
  resetHostSessionMirrorHydrationForTests
} from '@/runtime/host-session-mirror-hydration'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'

// Deferring a mirrored pane's resume is only half the fix: whatever settles the
// mirror must replay the parked sweep, or the aug20 duplicate-launch defect is
// traded for a resume that never happens. These pin both halves plus the
// per-connection reset a host restart depends on.

const initialAppStoreState = useAppStore.getState()

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const WEB_TAB_ID = 'web-terminal-host-tab-1'
const RUNTIME_ENV_ID = 'env-abfee683'
const WORKTREE_ID = makeCreatedAgentWorktree().id

function makeRuntimeOwnedWorktree(): ReturnType<typeof makeCreatedAgentWorktree> {
  return {
    ...makeCreatedAgentWorktree(),
    createdWithAgent: undefined,
    hostId: `runtime:${encodeURIComponent(RUNTIME_ENV_ID)}`
  }
}

function seedState(worktree: ReturnType<typeof makeCreatedAgentWorktree>): void {
  const state: Partial<AppState> = {
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
    activeWorktreeId: worktree.id,
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
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-host-old-1' }
      } as never
    },
    settings: {
      agentCmdOverrides: {},
      setupScriptLaunchMode: 'new-tab'
    } as unknown as AppState['settings'],
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  }
  useAppStore.setState(state)
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
        origin: 'live' as const,
        capturedAt: 1000,
        updatedAt: 1000,
        terminalTitle: 'Codex'
      }
    }
  }))
  return paneKey
}

function retractMirroredTab(worktreeId: string): void {
  useAppStore.setState({ tabsByWorktree: { [worktreeId]: [] } })
}

function connectRuntime(runtimeId: string): void {
  useAppStore.getState().setRuntimeEnvironmentStatus(RUNTIME_ENV_ID, {
    status: {
      runtimeId,
      rendererGraphEpoch: 1,
      graphStatus: 'live',
      authoritativeWindowId: 1,
      liveTabCount: 1,
      liveLeafCount: 1
    } as never,
    checkedAt: 1
  })
}

beforeEach(() => {
  resetHostSessionMirrorHydrationForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
})

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
  resetHostSessionMirrorHydrationForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
})

describe('parked mirrored-pane resume replay', () => {
  it('replays the deferred sweep and relaunches once the mirror retracts the pane', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedState(worktree)
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-replay-1')

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()

    // The host answered: this pane is gone, so recovery is finally justified.
    retractMirroredTab(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    const after = useAppStore.getState()
    const tabs = after.tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(1)
    expect(after.automaticAgentResumeClaimsByTabId[tabs[0]!.id]?.providerSession).toEqual({
      key: 'session_id',
      id: 'codex-session-replay-1'
    })
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  })

  it('replays without relaunching when the mirror reports the host PTY live', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedState(worktree)
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-replay-2')

    resumeSleepingAgentSessionsForWorktree(worktree.id)

    // The host answered: the PTY is still attached to the mirrored pane.
    useAppStore.setState({ ptyIdsByTabId: { [WEB_TAB_ID]: ['pty-host-old-1'] } })
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    const after = useAppStore.getState()
    expect((after.tabsByWorktree[worktree.id] ?? []).map((tab) => tab.id)).toEqual([WEB_TAB_ID])
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('drops the hydrated verdict when the host reconnects under a new runtime id', () => {
    connectRuntime('runtime-a')
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(hasHostSessionMirrorHydrated(RUNTIME_ENV_ID, WORKTREE_ID)).toBe(true)

    // A host app restart: same environment, new connection, unknown PTYs again.
    connectRuntime('runtime-b')
    expect(hasHostSessionMirrorHydrated(RUNTIME_ENV_ID, WORKTREE_ID)).toBe(false)

    const worktree = makeRuntimeOwnedWorktree()
    seedState(worktree)
    const paneKey = seedSleepingRecord(worktree.id, 'codex-session-replay-3')

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })
})
