import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import {
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from '@/runtime/web-session-tabs-sync-test-harness'
import {
  markHostSessionMirrorHydrated,
  resetHostSessionMirrorHydrationForTests
} from '@/runtime/host-session-mirror-hydration'
import { useAppStore, type AppState } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { Worktree } from '../../../shared/worktree/types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { makeCreatedAgentWorktree } from './worktree-activation-created-agent.test-fixture'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

// #21235: a paired client is never the execution host, so no local record can tell "another client
// closed this tab" from a re-key or a pending handle. Whatever shape the record's pane key has, the
// sweep must not start a second writer on the host for it.

const initialState = useAppStore.getState()
const ENV_ID = 'env-closed-elsewhere'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const CLIENT_TAB_ID = 'client-created-tab'

function seedPairedWorkspace(paired = true): string {
  const worktree: Worktree = {
    ...makeCreatedAgentWorktree(),
    createdWithAgent: undefined,
    ...(paired ? { hostId: `runtime:${encodeURIComponent(ENV_ID)}` } : {})
  }
  const seed: Partial<AppState> = {
    repos: [
      {
        id: worktree.repoId,
        path: path.join(path.sep, 'workspace', 'repo'),
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { [worktree.repoId]: [worktree] },
    activeRepoId: worktree.repoId,
    activeWorktreeId: worktree.id,
    activeView: 'terminal',
    tabsByWorktree: { [worktree.id]: [] },
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    sleepingAgentSessionsByPaneKey: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    agentStatusByPaneKey: {}
  }
  useAppStore.setState(seed)
  markHostSessionMirrorHydrated(ENV_ID)
  return worktree.id
}

function makeRecord(worktreeId: string, tabId: string): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey(tabId, LEAF_ID),
    tabId,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'closed-elsewhere' },
    origin: 'live',
    state: 'working',
    prompt: 'continue',
    capturedAt: 1,
    updatedAt: 1
  }
}

function seedRecord(record: SleepingAgentSessionRecord): void {
  useAppStore.setState({
    sleepingAgentSessionsByPaneKey: {
      ...useAppStore.getState().sleepingAgentSessionsByPaneKey,
      [record.paneKey]: record
    }
  })
}

function applyHostTabs(worktreeId: string, hostTabIds: readonly string[], version: number): void {
  const snapshot = makeSnapshot(
    hostTabIds.map((hostTabId, index) => ({
      type: 'terminal' as const,
      id: `${hostTabId}::${LEAF_ID}`,
      title: 'Claude',
      parentTabId: hostTabId,
      leafId: LEAF_ID,
      isActive: index === 0,
      status: 'ready' as const,
      terminal: `term-${hostTabId}`
    })),
    { worktree: worktreeId, snapshotVersion: version }
  )
  useAppStore.setState(
    applyWebSessionTabsSnapshot(useAppStore.getState(), snapshot, ENV_ID, Date.now())
  )
}

function expectNoAutomaticResume(worktreeId: string): void {
  expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
  const state = useAppStore.getState()
  expect(state.tabsByWorktree[worktreeId] ?? []).toEqual([])
  expect(state.pendingStartupByTabId).toEqual({})
  expect(state.automaticAgentResumeClaimsByTabId).toEqual({})
}

describe('a tab closed on another paired client', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    resetWebSessionTabsSyncTestState()
    resetHostSessionMirrorHydrationForTests()
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    resetWebSessionTabsSyncTestState()
    resetHostSessionMirrorHydrationForTests()
  })

  it('is not resumed from a record keyed by the tab id this client created it under', () => {
    const worktreeId = seedPairedWorkspace()
    useAppStore.setState({
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: CLIENT_TAB_ID,
            ptyId: null,
            worktreeId,
            title: 'Claude',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })
    const record = makeRecord(worktreeId, CLIENT_TAB_ID)
    seedRecord(record)

    // The host adopts the client's tab id, then another client closes it.
    applyHostTabs(worktreeId, [CLIENT_TAB_ID], 1)
    expect(useAppStore.getState().tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([
      toWebTerminalSurfaceTabId(CLIENT_TAB_ID)
    ])
    applyHostTabs(worktreeId, [], 2)

    expectNoAutomaticResume(worktreeId)
    expectNoAutomaticResume(worktreeId)
  })

  it('is not resumed from a native-keyed record the host never published', () => {
    const worktreeId = seedPairedWorkspace()
    seedRecord(makeRecord(worktreeId, 'native-tab'))

    expectNoAutomaticResume(worktreeId)
  })

  it('is not resumed from a native record that shares its session with a mirrored one', () => {
    const worktreeId = seedPairedWorkspace()
    seedRecord(makeRecord(worktreeId, toWebTerminalSurfaceTabId('host-tab')))
    seedRecord({ ...makeRecord(worktreeId, 'native-tab'), capturedAt: 2, updatedAt: 2 })

    expectNoAutomaticResume(worktreeId)
    expectNoAutomaticResume(worktreeId)
  })

  it('still recovers a local native record when the mirror names another execution host', () => {
    const worktreeId = seedPairedWorkspace(false)
    seedRecord({
      ...makeRecord(worktreeId, toWebTerminalSurfaceTabId('host-tab')),
      connectionId: 'other-ssh-target'
    })
    const native = { ...makeRecord(worktreeId, 'native-tab'), connectionId: null, capturedAt: 2 }
    seedRecord(native)

    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(1)
    expect(Object.values(useAppStore.getState().pendingStartupByTabId)).toMatchObject([
      { resumeProviderSession: native.providerSession }
    ])
  })
})
