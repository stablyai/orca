import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { applyDirectSshRemoteWorkspaceSnapshot } from '../hooks/remote-workspace-snapshot-apply'
import type { DirectSshSnapshotApplyToken } from '../hooks/direct-ssh-reconnect-coordinator-types'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'repo-1::/repo'
const TARGET_ID = 'target-a'

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey('tab-1', LEAF_ID),
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    origin: 'quit',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function seedSshWorktreeState(overrides: Record<string, unknown> = {}): void {
  const record = makeRecord()
  useAppStore.setState({
    repos: [
      {
        id: 'repo-1',
        name: 'repo',
        path: '/repo',
        connectionId: TARGET_ID,
        executionHostId: `ssh:${TARGET_ID}`
      }
    ],
    worktreesByRepo: {
      'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1', path: '/repo', hostId: `ssh:${TARGET_ID}` }]
    },
    tabsByWorktree: { [WORKTREE_ID]: [] },
    sshConnectionStates: new Map([[TARGET_ID, { status: 'connected' }]]),
    remoteWorkspaceHydratedTargetIds: new Set<string>(),
    remoteWorkspaceSyncStatusByTargetId: {},
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
    ...overrides
  } as never)
}

const authority: DirectSshAuthority = {
  targetId: TARGET_ID,
  providerEpoch: 'provider-epoch-1' as SshProviderEpoch,
  connectionGeneration: 1
}

function snapshot(): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision: 1,
    updatedAt: 1,
    schemaVersion: 1,
    session: {
      activeWorktreePath: '/repo',
      activeTabId: 'tab-1',
      tabsByWorktreePath: {
        '/repo': [
          {
            id: 'tab-1',
            worktreePath: '/repo',
            ptyId: 'pty-remote',
            title: 'Agent',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-remote' }
        }
      },
      activeWorktreePathsOnShutdown: ['/repo'],
      activeTabIdByWorktreePath: { '/repo': 'tab-1' },
      remoteSessionIdsByTabId: { 'tab-1': 'pty-remote' },
      lastVisitedAtByWorktreePath: { '/repo': 1 },
      defaultTerminalTabsAppliedByWorktreePath: { '/repo': true }
    }
  }
}

function applyToken(): DirectSshSnapshotApplyToken {
  return {
    authority,
    catalogRevision: 0,
    repoFingerprint: 'fp',
    authorityRequirement: 'required',
    snapshotRevision: 1,
    outcome: 'complete'
  }
}

describe('resumeSleepingAgentSessionsForWorktree — remote hydration gate', () => {
  it('defers the sweep while a connected target has not merged its snapshot', () => {
    seedSshWorktreeState()

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    expect(launched).toBe(0)
    expect(Object.keys(useAppStore.getState().sleepingAgentSessionsByPaneKey)).toHaveLength(1)
  })

  it('sweeps once the target is hydrated', () => {
    seedSshWorktreeState({ remoteWorkspaceHydratedTargetIds: new Set(['target-a']) })

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(1)
  })

  it('sweeps when the target is disconnected', () => {
    seedSshWorktreeState({
      sshConnectionStates: new Map([['target-a', { status: 'disconnected' }]])
    })

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(1)
  })

  it('sweeps when the first pull concluded without a snapshot', () => {
    seedSshWorktreeState({
      remoteWorkspaceSyncStatusByTargetId: { 'target-a': { phase: 'offline', direction: 'pull' } }
    })

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(1)
  })

  it('never defers local worktrees', () => {
    const record = makeRecord({ worktreeId: 'wt-local' })
    useAppStore.setState({
      tabsByWorktree: { 'wt-local': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-local')).toBe(1)
  })

  it('preserves the remote tab, pane, PTY, and provider session across the ordered merge', async () => {
    seedSshWorktreeState({
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceKey: `worktree:${WORKTREE_ID}`,
      remoteWorkspaceSyncStatusByTargetId: {
        [TARGET_ID]: { phase: 'pulling', direction: 'pull' }
      },
      reconnectPersistedTerminals: vi.fn(async () => {})
    })
    const record = Object.values(useAppStore.getState().sleepingAgentSessionsByPaneKey)[0]

    const preMergeLaunches = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)
    await applyDirectSshRemoteWorkspaceSnapshot({
      store: useAppStore,
      snapshot: snapshot(),
      token: applyToken(),
      arrival: 1,
      isArrivalCurrent: () => true,
      isPreparationTokenCurrent: () => true,
      waitForWorkspaceSessionReady: async () => true,
      finalizeHydratedTerminals: () => 0
    })

    const state = useAppStore.getState()
    expect(preMergeLaunches).toBe(0)
    expect(state.tabsByWorktree[WORKTREE_ID].map((tab) => tab.id)).toEqual(['tab-1'])
    expect(state.terminalLayoutsByTabId['tab-1']?.root).toEqual({
      type: 'leaf',
      leafId: LEAF_ID
    })
    expect(state.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe('pty-remote')
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    expect(state.pendingStartupByTabId).toEqual({})
    expect(state.automaticAgentResumeClaimsByTabId).toEqual({})
  })
})
