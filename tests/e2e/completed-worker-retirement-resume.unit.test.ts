import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../src/shared/agent-session-resume'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { tokenizeStartupCommand } from '../../src/shared/tui-agent-startup-shell'
import { parseWorkspaceSession } from '../../src/shared/workspace-session-schema'
import type { TerminalTab, Worktree } from '../../src/shared/types'
import { completeWorkerTerminalRelease } from '../../src/main/runtime/rpc/methods/orchestration-worker-release-completion'
import type { WorkerTerminalResourceRow } from '../../src/main/runtime/orchestration/worker-terminal-ownership'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import {
  resolveLegacyWorkerTerminalRecoveryAction,
  rollbackLegacyWorkerTerminalSurfaceInStore
} from '@/hooks/legacy-worker-terminal-recovery-event'
import { useAppStore, type AppState } from '@/store'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'

const PROVIDER_SESSION_ID = '019feb51-2269-71c2-89c6-faa8dc65c8dc'
const ORIGINAL_TAB_ID = '1c897bc8-973b-47b4-9449-ac5fc6b726c3'
const ORIGINAL_LEAF_ID = '0526f763-6729-49af-adf8-85ddbcf2b4e7'
const ORIGINAL_PANE_KEY = makePaneKey(ORIGINAL_TAB_ID, ORIGINAL_LEAF_ID)
const ORIGINAL_PTY_ID = 'pty-background-worker'
const REPO_ID = '32a0226d-9f33-42e8-8b7b-24867dea06d4'
const WORKTREE_PATH = path.join(path.sep, 'workspace', 'factory-pr-4626-git-crypt')
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const CANARY_WORKTREE_ID = `${REPO_ID}::canary`
const CANARY_TAB_ID = 'canary-tab'
const CANARY_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const CANARY_PTY_ID = 'pty-unrelated-canary'
const HELPER_TAB_ID = 'worker-child-terminal'
const HELPER_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const HELPER_PANE_KEY = makePaneKey(HELPER_TAB_ID, HELPER_LEAF_ID)
const DISPATCH_ID = 'dispatch-completed-worker'
const TERMINAL_HANDLE = 'terminal-background-worker'
const initialAppStoreState = useAppStore.getState()

function makeWorktree(id: string, workspacePath: string): Worktree {
  return {
    id,
    repoId: REPO_ID,
    path: workspacePath,
    head: 'abc123',
    branch: 'refs/heads/review',
    isBare: false,
    isMainWorktree: false,
    displayName: path.basename(workspacePath),
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    hostId: 'local'
  }
}

function makeTab(id: string, worktreeId: string, ptyId: string, title: string): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeLayout(leafId: string, ptyId: string) {
  return {
    root: { type: 'leaf' as const, leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

function seedWorkspace(options: { helper?: boolean } = {}): void {
  useAppStore.setState(initialAppStoreState, true)
  const target = makeWorktree(WORKTREE_ID, WORKTREE_PATH)
  const canary = makeWorktree(CANARY_WORKTREE_ID, path.join(path.sep, 'workspace', 'canary'))
  const original = makeTab(
    ORIGINAL_TAB_ID,
    WORKTREE_ID,
    ORIGINAL_PTY_ID,
    'PR 4626 unified correction r3'
  )
  const unrelated = makeTab(CANARY_TAB_ID, CANARY_WORKTREE_ID, CANARY_PTY_ID, 'Unrelated')
  const helper = makeTab(HELPER_TAB_ID, WORKTREE_ID, 'pty-worker-child', 'Worker child')
  useAppStore.setState({
    repos: [
      {
        id: REPO_ID,
        path: path.join(path.sep, 'workspace'),
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0,
        executionHostId: 'local'
      }
    ],
    worktreesByRepo: { [REPO_ID]: [target, canary] },
    activeRepoId: REPO_ID,
    activeWorktreeId: CANARY_WORKTREE_ID,
    activeTabId: CANARY_TAB_ID,
    activeTabType: 'terminal',
    activeView: 'terminal',
    tabsByWorktree: {
      [WORKTREE_ID]: options.helper ? [original, helper] : [original],
      [CANARY_WORKTREE_ID]: [unrelated]
    },
    ptyIdsByTabId: {
      [ORIGINAL_TAB_ID]: [ORIGINAL_PTY_ID],
      [CANARY_TAB_ID]: [CANARY_PTY_ID],
      ...(options.helper ? { [HELPER_TAB_ID]: ['pty-worker-child'] } : {})
    },
    terminalLayoutsByTabId: {
      [ORIGINAL_TAB_ID]: makeLayout(ORIGINAL_LEAF_ID, ORIGINAL_PTY_ID),
      [CANARY_TAB_ID]: makeLayout(CANARY_LEAF_ID, CANARY_PTY_ID),
      ...(options.helper ? { [HELPER_TAB_ID]: makeLayout(HELPER_LEAF_ID, 'pty-worker-child') } : {})
    },
    activeTabIdByWorktree: {
      [WORKTREE_ID]: ORIGINAL_TAB_ID,
      [CANARY_WORKTREE_ID]: CANARY_TAB_ID
    },
    activeTabTypeByWorktree: {
      [WORKTREE_ID]: 'terminal',
      [CANARY_WORKTREE_ID]: 'terminal'
    },
    tabBarOrderByWorktree: {
      [WORKTREE_ID]: options.helper ? [ORIGINAL_TAB_ID, HELPER_TAB_ID] : [ORIGINAL_TAB_ID],
      [CANARY_WORKTREE_ID]: [CANARY_TAB_ID]
    },
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    everActivatedWorktreeIds: new Set([CANARY_WORKTREE_ID]),
    settings: {
      ...initialAppStoreState.settings,
      agentCmdOverrides: {},
      agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
      setupScriptLaunchMode: 'new-tab'
    },
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  } as Partial<AppState>)
}

function recordWorkingWorker() {
  const providerSession = { key: 'session_id' as const, id: PROVIDER_SESSION_ID }
  useAppStore
    .getState()
    .setAgentStatus(
      ORIGINAL_PANE_KEY,
      { state: 'working', prompt: 'review PR 4626', agentType: 'codex' },
      'PR 4626 unified correction r3',
      { updatedAt: 1_786_361_478_130, stateStartedAt: 1_786_361_478_130 },
      { tabId: ORIGINAL_TAB_ID, worktreeId: WORKTREE_ID, terminalHandle: TERMINAL_HANDLE },
      { providerSession }
    )
  return providerSession
}

function completeRecordedWorker(
  providerSession: ReturnType<typeof recordWorkingWorker>
): SleepingAgentSessionRecord {
  useAppStore
    .getState()
    .setAgentStatus(
      ORIGINAL_PANE_KEY,
      { state: 'done', prompt: 'review PR 4626', agentType: 'codex' },
      'PR 4626 unified correction r3',
      { updatedAt: 1_786_361_625_666, stateStartedAt: 1_786_361_625_666 },
      { tabId: ORIGINAL_TAB_ID, worktreeId: WORKTREE_ID, terminalHandle: TERMINAL_HANDLE },
      { providerSession }
    )
  expect(useAppStore.getState().agentStatusByPaneKey[ORIGINAL_PANE_KEY]).toMatchObject({
    state: 'done',
    providerSession
  })
  const record = useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]
  expect(record).toMatchObject({
    paneKey: ORIGINAL_PANE_KEY,
    tabId: ORIGINAL_TAB_ID,
    worktreeId: WORKTREE_ID,
    agent: 'codex',
    providerSession,
    state: 'working',
    origin: 'live'
  })
  return record!
}

function recordCompletedWorker(): SleepingAgentSessionRecord {
  return completeRecordedWorker(recordWorkingWorker())
}

function expectCanaryUnchanged(): void {
  const state = useAppStore.getState()
  expect(state.tabsByWorktree[CANARY_WORKTREE_ID]).toEqual([
    expect.objectContaining({ id: CANARY_TAB_ID, ptyId: CANARY_PTY_ID })
  ])
  expect(state.terminalLayoutsByTabId[CANARY_TAB_ID]).toEqual(
    makeLayout(CANARY_LEAF_ID, CANARY_PTY_ID)
  )
}

async function releaseAlreadyExitedWorker(): Promise<void> {
  const resource: WorkerTerminalResourceRow = {
    id: 'resource-completed-worker',
    origin_dispatch_id: DISPATCH_ID,
    owner_dispatch_id: DISPATCH_ID,
    prior_owner_dispatch_ids: '[]',
    worktree_id: WORKTREE_ID,
    terminal_handle: TERMINAL_HANDLE,
    pane_key: ORIGINAL_PANE_KEY,
    process_incarnation: 'runtime:test:worker:1',
    host_scope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    ownership_state: 'owned',
    release_state: 'requested',
    retained_reason: null,
    release_requested_at: '2026-08-10T23:35:00.000Z',
    release_completed_at: null,
    release_error: null,
    archive_source: null,
    archive_status: null,
    created_at: '2026-08-10T11:31:00.000Z',
    updated_at: '2026-08-10T23:35:00.000Z'
  }
  const dispatch = {
    id: DISPATCH_ID,
    state: 'succeeded',
    agent_terminal_handle: TERMINAL_HANDLE,
    created_at: resource.created_at
  }
  let releasedResource: WorkerTerminalResourceRow | null = null
  const db = {
    getWorkerDispatch: vi.fn(() => dispatch),
    isDispatchProcessCurrent: vi.fn(() => true),
    workerTerminalResourceHasIdentityConflict: vi.fn(() => false),
    getWorkerTerminalArchive: vi.fn(() => null),
    commitWorkerTerminalArchiveForRelease: vi.fn(() => ({
      ...resource,
      archive_source: 'terminal',
      archive_status: 'empty',
      release_state: 'releasing'
    })),
    settleWorkerTerminalRelease: vi.fn(() => {
      releasedResource = {
        ...resource,
        ownership_state: 'released',
        release_state: 'released',
        archive_source: 'terminal',
        archive_status: 'empty'
      }
      return releasedResource
    })
  }
  const runtime = {
    showTerminal: vi.fn(async () => ({
      handle: TERMINAL_HANDLE,
      worktreeId: WORKTREE_ID,
      connected: false
    })),
    getTerminalPaneKey: vi.fn(() => ORIGINAL_PANE_KEY),
    getTerminalProcessIncarnation: vi.fn(() => 'runtime:test:worker:1'),
    getOrchestrationDispatchAuthority: vi.fn(() => ({
      terminalHandle: TERMINAL_HANDLE,
      paneKey: ORIGINAL_PANE_KEY,
      processIncarnation: 'runtime:test:worker:1',
      hostScope: { kind: 'local', hostId: 'local' }
    })),
    getExactWorkerProviderSession: vi.fn(() => null),
    readTerminal: vi.fn(async () => ({
      handle: TERMINAL_HANDLE,
      status: 'exited',
      tail: [],
      truncated: false,
      nextCursor: null
    })),
    closeTerminal: vi.fn(async () => {
      closeTerminalTab(ORIGINAL_TAB_ID, {
        force: true,
        skipRunningProcessConfirm: true,
        localPtyTeardownOwnedExternally: true
      })
      return { handle: TERMINAL_HANDLE, closed: true }
    }),
    notifyMessageArrived: vi.fn()
  }

  const receipt = await completeWorkerTerminalRelease({
    runtime: runtime as never,
    db: db as never,
    dispatchId: DISPATCH_ID,
    resource
  })

  expect(dispatch.state).toBe('succeeded')
  expect(receipt).toMatchObject({
    dispatchId: DISPATCH_ID,
    state: 'released',
    processAction: 'closed_exited_terminal',
    archive: { source: 'terminal', status: 'empty' }
  })
  expect(releasedResource).toMatchObject({ ownership_state: 'released', release_state: 'released' })
  expect(runtime.closeTerminal).toHaveBeenCalledOnce()
}

function persistAndParseCurrentSession() {
  const parsed = parseWorkspaceSession(buildWorkspaceSessionPayload(useAppStore.getState()))
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return parsed.value
}

beforeEach(() => {
  vi.stubGlobal('window', {
    api: {
      pty: { kill: vi.fn().mockResolvedValue(undefined) },
      runtime: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) },
      runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
    }
  })
  seedWorkspace()
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

describe('completed background-worker retirement resume matrix', () => {
  it('does not cold-resume an explicitly completed and retired worker on first activation', async () => {
    // Case 1: task completion alone keeps the still-owned provider session recoverable in place.
    const ownedRecord = recordCompletedWorker()
    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]).toBe(
      ownedRecord
    )

    // Case 2: explicit `orca terminal close` retires the exact tab and its resume authority.
    seedWorkspace()
    recordCompletedWorker()
    closeTerminalTab(ORIGINAL_TAB_ID, {
      force: true,
      skipRunningProcessConfirm: true,
      localPtyTeardownOwnedExternally: true
    })
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]).toBeUndefined()
    expectCanaryUnchanged()

    // Case 3: PTY-exit-first worker-release settles, but its late missing-tab close cannot retire.
    seedWorkspace()
    recordCompletedWorker()
    useAppStore.getState().removeAgentStatus(ORIGINAL_PANE_KEY)
    useAppStore.getState().closeTab(ORIGINAL_TAB_ID, { reason: 'pty-exit' })
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(useAppStore.getState().terminalLayoutsByTabId[ORIGINAL_TAB_ID]).toBeUndefined()
    expect(useAppStore.getState().ptyIdsByTabId[ORIGINAL_TAB_ID]).toBeUndefined()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]).toMatchObject({
      origin: 'live',
      state: 'working',
      providerSession: { key: 'session_id', id: PROVIDER_SESSION_ID }
    })
    await releaseAlreadyExitedWorker()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]).toBeDefined()

    const staleRestart = persistAndParseCurrentSession()
    expect(staleRestart.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(staleRestart.sleepingAgentSessionsByPaneKey?.[ORIGINAL_PANE_KEY]).toBeDefined()

    // Case 4: legacy rollback preserves a fenced record; exited/adopted resolution clears it.
    seedWorkspace()
    const legacyRecord = recordCompletedWorker()
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [ORIGINAL_PANE_KEY]: {
          ...legacyRecord,
          automaticResumeBlockedBy: 'legacy-orchestration-worker'
        }
      }
    })
    const legacyAction = resolveLegacyWorkerTerminalRecoveryAction({
      paneKey: ORIGINAL_PANE_KEY,
      resolution: 'rolled_back',
      ptyId: ORIGINAL_PTY_ID
    })
    expect(legacyAction.kind).toBe('rollback-surface')
    if (legacyAction.kind === 'rollback-surface') {
      expect(
        rollbackLegacyWorkerTerminalSurfaceInStore(useAppStore.getState(), legacyAction.detail)
      ).toBe('removed')
    }
    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expect(
      useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]
        ?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
    const exitedAction = resolveLegacyWorkerTerminalRecoveryAction({
      paneKey: ORIGINAL_PANE_KEY,
      resolution: 'exited'
    })
    expect(exitedAction).toEqual({ kind: 'clear-sleeping', paneKey: ORIGINAL_PANE_KEY })
    useAppStore.getState().clearSleepingAgentSession(ORIGINAL_PANE_KEY)

    // Case 5: coordinator manual close is the same safe exact-tab retirement boundary.
    seedWorkspace()
    recordCompletedWorker()
    closeTerminalTab(ORIGINAL_TAB_ID, {
      force: true,
      skipRunningProcessConfirm: true,
      localPtyTeardownOwnedExternally: true
    })
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]).toBeUndefined()
    expectCanaryUnchanged()

    // Case 6: normal Codex exit leaves the shell pane; helper close retires only the helper.
    seedWorkspace({ helper: true })
    recordCompletedWorker()
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        ...useAppStore.getState().sleepingAgentSessionsByPaneKey,
        [HELPER_PANE_KEY]: {
          paneKey: HELPER_PANE_KEY,
          tabId: HELPER_TAB_ID,
          worktreeId: WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'unrelated-helper-session' },
          prompt: 'helper',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    })
    useAppStore.getState().removeAgentStatus(ORIGINAL_PANE_KEY)
    closeTerminalTab(HELPER_TAB_ID, {
      force: true,
      skipRunningProcessConfirm: true,
      localPtyTeardownOwnedExternally: true
    })
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[HELPER_PANE_KEY]).toBeUndefined()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]).toBeDefined()
    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expectCanaryUnchanged()

    // Case 7: restart preserves an owned working or completed pane, and also the stale orphan.
    seedWorkspace()
    const workingProviderSession = recordWorkingWorker()
    const beforeCompletion = persistAndParseCurrentSession()
    expect(beforeCompletion.tabsByWorktree[WORKTREE_ID]?.[0]).toMatchObject({
      id: ORIGINAL_TAB_ID,
      ptyId: ORIGINAL_PTY_ID
    })
    expect(beforeCompletion.sleepingAgentSessionsByPaneKey?.[ORIGINAL_PANE_KEY]).toMatchObject({
      state: 'working',
      origin: 'live',
      providerSession: workingProviderSession
    })
    completeRecordedWorker(workingProviderSession)
    const afterCompletion = persistAndParseCurrentSession()
    expect(afterCompletion.tabsByWorktree[WORKTREE_ID]?.[0]).toMatchObject({
      id: ORIGINAL_TAB_ID,
      ptyId: ORIGINAL_PTY_ID
    })
    expect(afterCompletion.terminalLayoutsByTabId[ORIGINAL_TAB_ID]?.ptyIdsByLeafId).toEqual({
      [ORIGINAL_LEAF_ID]: ORIGINAL_PTY_ID
    })
    expect(afterCompletion.sleepingAgentSessionsByPaneKey?.[ORIGINAL_PANE_KEY]).toBeDefined()

    useAppStore.getState().removeAgentStatus(ORIGINAL_PANE_KEY)
    useAppStore.getState().closeTab(ORIGINAL_TAB_ID, { reason: 'pty-exit' })
    await releaseAlreadyExitedWorker()
    const restartAfterRetirement = persistAndParseCurrentSession()
    useAppStore.setState(initialAppStoreState, true)
    seedWorkspace()
    useAppStore.getState().closeTab(ORIGINAL_TAB_ID, { reason: 'pty-exit' })
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: restartAfterRetirement.sleepingAgentSessionsByPaneKey ?? {},
      everActivatedWorktreeIds: new Set([CANARY_WORKTREE_ID])
    })

    // Case 8: first activation of the never-visited target consumes the stale orphan.
    expect(useAppStore.getState().everActivatedWorktreeIds.has(WORKTREE_ID)).toBe(false)
    const tabCountBeforeActivation = useAppStore.getState().tabsByWorktree[WORKTREE_ID]?.length ?? 0
    activateAndRevealWorktree(WORKTREE_ID, { notifyHostRuntime: false })
    const activated = useAppStore.getState()
    const replacementTabs = (activated.tabsByWorktree[WORKTREE_ID] ?? []).filter(
      (tab) => tab.id !== ORIGINAL_TAB_ID
    )
    const spawnRequests = replacementTabs.flatMap((tab) => {
      const startup = activated.pendingStartupByTabId[tab.id]
      if (!startup?.resumeProviderSession) {
        return []
      }
      const tokens = tokenizeStartupCommand(startup.command, 'posix')
      expect(tokens.ok).toBe(true)
      return [
        {
          providerSession: startup.resumeProviderSession,
          command: startup.command,
          argv: tokens.ok ? tokens.tokens : [],
          restoredBannerCount: startup.showSessionRestoredBanner ? 1 : 0
        }
      ]
    })

    expect(tabCountBeforeActivation).toBe(0)
    expect(replacementTabs).toHaveLength(1)
    expect(activated.tabsByWorktree[WORKTREE_ID]?.some((tab) => tab.id === ORIGINAL_TAB_ID)).toBe(
      false
    )
    expect(activated.terminalLayoutsByTabId[ORIGINAL_TAB_ID]).toBeUndefined()
    expect(activated.ptyIdsByTabId[ORIGINAL_TAB_ID]).toBeUndefined()
    expect(spawnRequests).toEqual([
      expect.objectContaining({
        providerSession: { key: 'session_id', id: PROVIDER_SESSION_ID },
        command: `codex '--dangerously-bypass-approvals-and-sandbox' 'resume' '${PROVIDER_SESSION_ID}'`,
        argv: [
          'codex',
          '--dangerously-bypass-approvals-and-sandbox',
          'resume',
          PROVIDER_SESSION_ID
        ],
        restoredBannerCount: 1
      })
    ])
    expectCanaryUnchanged()
    expect(Object.keys(activated.pendingStartupByTabId)).toHaveLength(1)
    expect(Object.keys(activated.automaticAgentResumeClaimsByTabId)).toHaveLength(1)

    // Required invariant: explicit completion plus retirement must revoke provider-resume authority.
    expect(spawnRequests).toEqual([])
  })
})
