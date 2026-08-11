import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../src/shared/agent-session-resume'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { tokenizeStartupCommand } from '../../src/shared/tui-agent-startup-shell'
import { parseWorkspaceSession } from '../../src/shared/workspace-session-schema'
import type { TerminalTab, Worktree } from '../../src/shared/types'
import { OrchestrationDb } from '../../src/main/runtime/orchestration/db'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import type { RpcContext } from '../../src/main/runtime/rpc/core'
import { ORCHESTRATION_METHODS } from '../../src/main/runtime/rpc/methods/orchestration'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { seedStartupSessionRestoredBanner } from '@/components/terminal-pane/session-restored-banner-pane-state'
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
const CANARY_WORKTREE_PATH = path.join(path.sep, 'workspace', 'canary')
const CANARY_WORKTREE_ID = `${REPO_ID}::${CANARY_WORKTREE_PATH}`
const CANARY_TAB_ID = 'canary-tab'
const CANARY_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const CANARY_PTY_ID = 'pty-unrelated-canary'
const HELPER_TAB_ID = 'worker-child-terminal'
const HELPER_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const HELPER_PANE_KEY = makePaneKey(HELPER_TAB_ID, HELPER_LEAF_ID)
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
  const canary = makeWorktree(CANARY_WORKTREE_ID, CANARY_WORKTREE_PATH)
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

function orchestrationMethod(name: string) {
  const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`Missing orchestration method: ${name}`)
  }
  return method
}

async function releaseCompletedWorker(terminalState: 'running' | 'exited'): Promise<void> {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const coordinatorPaneKey = 'coordinator-tab:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const run = db.createRun({
    objective: 'Completed worker retirement reproduction',
    coordinatorHandle: 'terminal-coordinator',
    coordinatorPaneKey
  })
  const ctx: RpcContext = { runtime }
  const call = async (name: string, params: Record<string, unknown>) => {
    const method = orchestrationMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'terminal-coordinator' ? coordinatorPaneKey : ORIGINAL_PANE_KEY
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    handle === TERMINAL_HANDLE ? 'runtime:test:worker:1' : null
  )
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
    handle === TERMINAL_HANDLE
      ? ({
          terminalHandle: TERMINAL_HANDLE,
          paneKey: ORIGINAL_PANE_KEY,
          processIncarnation: 'runtime:test:worker:1',
          hostScope: { kind: 'local', hostId: 'local' }
        } as never)
      : null
  )
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({ id: WORKTREE_ID } as never)
  vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: TERMINAL_HANDLE,
    worktreeId: WORKTREE_ID,
    title: 'PR 4626 unified correction r3'
  })
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    handle: TERMINAL_HANDLE,
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle: TERMINAL_HANDLE,
    accepted: true,
    bytesWritten: 1
  })
  vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
  vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
  vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
    handle: TERMINAL_HANDLE,
    worktreeId: WORKTREE_ID,
    ...(terminalState === 'exited' ? { connected: false } : { status: 'running' })
  } as never)
  vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
    handle: TERMINAL_HANDLE,
    status: terminalState,
    tail: terminalState === 'exited' ? [] : ['completed worker output'],
    truncated: false,
    nextCursor: terminalState === 'exited' ? null : '1'
  })
  const closeTerminal = vi.spyOn(runtime, 'closeTerminal').mockImplementation(async () => {
    closeTerminalTab(ORIGINAL_TAB_ID, {
      force: true,
      skipRunningProcessConfirm: true,
      localPtyTeardownOwnedExternally: true
    })
    return { handle: TERMINAL_HANDLE, tabId: ORIGINAL_TAB_ID, ptyKilled: true }
  })
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

  try {
    const task = db.createTask({ spec: 'release completed worker', runId: run.id })
    const started = (await call('orchestration.workerStart', {
      task: task.id,
      from: 'terminal-coordinator',
      agent: 'codex'
    })) as { dispatchId: string; state: string }
    expect(started.state).toBe('ready')
    expect(db.getWorkerDispatch(started.dispatchId)?.state).toBe('ready')
    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatchId,
        outcome: 'succeeded',
        result: 'worker completed'
      }).action
    ).toBe('settled')
    expect(db.getWorkerDispatch(started.dispatchId)?.state).toBe('succeeded')

    await expect(
      call('orchestration.workerRelease', { dispatch: started.dispatchId })
    ).resolves.toMatchObject({
      dispatchId: started.dispatchId,
      state: 'released',
      processAction: terminalState === 'exited' ? 'closed_exited_terminal' : 'closed_agent_terminal'
    })
    expect(db.getWorkerDispatch(started.dispatchId)?.state).toBe('succeeded')
    expect(db.getWorkerTerminalResourceByOwner(started.dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released',
      pane_key: ORIGINAL_PANE_KEY,
      terminal_handle: TERMINAL_HANDLE
    })
    expect(closeTerminal).toHaveBeenCalledOnce()
  } finally {
    db.close()
  }
}

function persistAndParseCurrentSession() {
  const payload = buildWorkspaceSessionPayload(useAppStore.getState())
  const parsed = parseWorkspaceSession(JSON.parse(JSON.stringify(payload)))
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return parsed.value
}

async function hydrateSession(
  session: ReturnType<typeof persistAndParseCurrentSession>
): Promise<void> {
  seedWorkspace()
  useAppStore.getState().hydrateWorkspaceSession(session)
  useAppStore.getState().hydrateTabsSession(session)
  await useAppStore.getState().reconnectPersistedTerminals()
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
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
  vi.restoreAllMocks()
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

    // Case 2: the renderer boundary used by an explicit Orca close retires the exact authority.
    seedWorkspace()
    recordCompletedWorker()
    closeTerminalTab(ORIGINAL_TAB_ID, {
      force: true,
      skipRunningProcessConfirm: true,
      localPtyTeardownOwnedExternally: true
    })
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]).toBeUndefined()
    expectCanaryUnchanged()

    // Case 3: both running and PTY-exit-first release retire exact resume authority.
    seedWorkspace()
    recordCompletedWorker()
    await releaseCompletedWorker('running')
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]).toBeUndefined()
    expectCanaryUnchanged()

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
    await releaseCompletedWorker('exited')
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]).toBeUndefined()

    const retiredRestart = persistAndParseCurrentSession()
    expect(retiredRestart.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(retiredRestart.sleepingAgentSessionsByPaneKey?.[ORIGINAL_PANE_KEY]).toBeUndefined()

    // Case 4: legacy rollback preserves a fenced record; exited resolution clears it.
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
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]?.[0]).toMatchObject({
      id: ORIGINAL_TAB_ID,
      ptyId: ORIGINAL_PTY_ID
    })
    expect(useAppStore.getState().terminalLayoutsByTabId[ORIGINAL_TAB_ID]).toEqual(
      makeLayout(ORIGINAL_LEAF_ID, ORIGINAL_PTY_ID)
    )
    closeTerminalTab(HELPER_TAB_ID, {
      force: true,
      skipRunningProcessConfirm: true,
      localPtyTeardownOwnedExternally: true
    })
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[HELPER_PANE_KEY]).toBeUndefined()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]).toBeDefined()
    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expectCanaryUnchanged()

    // Case 7: restart preserves owned panes, while post-retirement restart keeps authority absent.
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
    await hydrateSession(beforeCompletion)
    activateAndRevealWorktree(WORKTREE_ID, { notifyHostRuntime: false })
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]?.[0]?.id).toBe(ORIGINAL_TAB_ID)
    expect(Object.keys(useAppStore.getState().pendingStartupByTabId)).toEqual([])
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]?.[0]?.ptyId).toBe(ORIGINAL_PTY_ID)
    expect(useAppStore.getState().ptyIdsByTabId[ORIGINAL_TAB_ID]).toEqual([ORIGINAL_PTY_ID])
    completeRecordedWorker(recordWorkingWorker())
    const afterCompletion = persistAndParseCurrentSession()
    expect(afterCompletion.tabsByWorktree[WORKTREE_ID]?.[0]).toMatchObject({
      id: ORIGINAL_TAB_ID,
      ptyId: ORIGINAL_PTY_ID
    })
    expect(afterCompletion.terminalLayoutsByTabId[ORIGINAL_TAB_ID]?.ptyIdsByLeafId).toEqual({
      [ORIGINAL_LEAF_ID]: ORIGINAL_PTY_ID
    })
    expect(afterCompletion.sleepingAgentSessionsByPaneKey?.[ORIGINAL_PANE_KEY]).toBeDefined()
    await hydrateSession(afterCompletion)
    activateAndRevealWorktree(WORKTREE_ID, { notifyHostRuntime: false })
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]?.[0]?.id).toBe(ORIGINAL_TAB_ID)
    expect(Object.keys(useAppStore.getState().pendingStartupByTabId)).toEqual([])
    expect(useAppStore.getState().tabsByWorktree[CANARY_WORKTREE_ID]?.[0]?.id).toBe(CANARY_TAB_ID)

    activateAndRevealWorktree(CANARY_WORKTREE_ID, { notifyHostRuntime: false })
    useAppStore.getState().removeAgentStatus(ORIGINAL_PANE_KEY)
    useAppStore.getState().closeTab(ORIGINAL_TAB_ID, { reason: 'pty-exit' })
    await releaseCompletedWorker('exited')
    const restartAfterRetirement = persistAndParseCurrentSession()
    await hydrateSession(restartAfterRetirement)

    // Case 8: first activation of the never-visited target cannot resurrect retired authority.
    const beforeActivation = useAppStore.getState()
    expect(beforeActivation.everActivatedWorktreeIds.has(WORKTREE_ID)).toBe(false)
    expect(beforeActivation.agentStatusByPaneKey[ORIGINAL_PANE_KEY]).toBeUndefined()
    expect(beforeActivation.sleepingAgentSessionsByPaneKey[ORIGINAL_PANE_KEY]).toBeUndefined()
    expect(Object.keys(beforeActivation.pendingStartupByTabId)).toEqual([])
    const tabCountBeforeActivation = beforeActivation.tabsByWorktree[WORKTREE_ID]?.length ?? 0
    activateAndRevealWorktree(WORKTREE_ID, { notifyHostRuntime: false })
    const activated = useAppStore.getState()
    const replacementTabs = (activated.tabsByWorktree[WORKTREE_ID] ?? []).filter(
      (tab) => tab.id !== ORIGINAL_TAB_ID
    )
    // The provider-ownership gate separately proves this request becomes one transport spawn.
    const coldSpawnRequests = replacementTabs.flatMap((tab) => {
      const startup = activated.pendingStartupByTabId[tab.id]
      if (!startup?.resumeProviderSession) {
        return []
      }
      const tokens = tokenizeStartupCommand(startup.command, 'posix')
      expect(tokens.ok).toBe(true)
      const showSessionRestoredBanner = vi.fn()
      seedStartupSessionRestoredBanner(startup, 1, showSessionRestoredBanner)
      return [
        {
          providerSession: startup.resumeProviderSession,
          command: startup.command,
          argv: tokens.ok ? tokens.tokens : [],
          restoredBannerCount: showSessionRestoredBanner.mock.calls.length
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
    expect(coldSpawnRequests).toEqual([])
    expectCanaryUnchanged()
    expect(Object.keys(activated.pendingStartupByTabId)).toHaveLength(0)
    expect(Object.keys(activated.automaticAgentResumeClaimsByTabId)).toHaveLength(0)

    // Required invariant: explicit completion plus retirement must revoke provider-resume authority.
    expect(coldSpawnRequests).toEqual([])
  })
})
