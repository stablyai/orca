// Launch settings must survive resume for records saved before resume identity existed (legacy)
// and for sessions launched with custom settings, across quit, restart and the replay of the main
// process's saved hook row (which carries no launch settings).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'

type TestStore = ReturnType<typeof createTestStore>

const holder = vi.hoisted((): { store?: TestStore } => ({}))

function currentStore(): TestStore {
  if (!holder.store) {
    throw new Error('Test store not initialised')
  }
  return holder.store
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => currentStore().getState(),
    setState: (partial: Partial<AppState>) => currentStore().setState(partial),
    subscribe: (listener: (state: AppState) => void) => currentStore().subscribe(listener)
  }
}))
vi.mock('sonner', () => ({
  toast: { message: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() }
}))

import { toast } from 'sonner'
import { createTestStore, makeTab } from './store-test-helpers'
import { getDefaultSettings } from '../../../../shared/constants'
import { sleepingAgentSessionsByPaneKeySchema } from '../../../../shared/workspace-session-sleeping-agents'
import { decodeHookResumeSession } from '../../../../shared/agent-resume-identity'
import { buildAgentStartupPlan } from '../../../../shared/tui-agent-startup'
import { launchSleepingAgentSession } from '@/lib/sleeping-agent-session-launch'
import { bindBuildColdRestoreAgentResumeStartup } from '@/components/terminal-pane/pty-connection/cold-restore-resume-startup'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const CLAUDE_ID = '0195f2ce-1111-4000-8000-000000000001'
const CODEX_ID = '0199f7a1-0000-7000-8000-000000000001'
const SETTINGS = {
  agentCmdOverrides: { claude: '/opt/settings/claude', codex: '/opt/settings/codex' },
  agentDefaultArgs: { claude: '--settings-arg', codex: '--settings-arg' },
  agentDefaultEnv: { claude: { FROM_SETTINGS: '1' }, codex: { FROM_SETTINGS: '1' } }
}

function resetStore(): TestStore {
  holder.store = createTestStore()
  const store = holder.store
  store.setState({ settings: { ...getDefaultSettings('/tmp'), ...SETTINGS } })
  return store
}

/** The shape origin/main wrote into the workspace session: no resume identity. */
function restoreMainRecord(
  agent: 'claude' | 'codex',
  launchConfig?: SleepingAgentSessionRecord['launchConfig']
): SleepingAgentSessionRecord {
  const parsed = sleepingAgentSessionsByPaneKeySchema.parse(
    JSON.parse(
      JSON.stringify({
        [PANE]: {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent,
          providerSession: { key: 'session_id', id: agent === 'claude' ? CLAUDE_ID : CODEX_ID },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1000,
          updatedAt: 1000,
          connectionId: null,
          ...(launchConfig ? { launchConfig } : {}),
          origin: 'quit'
        }
      })
    )
  )
  const record = parsed?.[PANE]
  if (!record) {
    throw new Error('Sleeping record was discarded')
  }
  currentStore().setState({ sleepingAgentSessionsByPaneKey: { [PANE]: record } })
  return record
}

/** What the main process replays after restart: its saved row, decoded from the route source. */
function replayHookRow(agent: 'claude' | 'codex'): void {
  currentStore()
    .getState()
    .setAgentStatus(
      PANE,
      { agentType: agent, state: 'working', prompt: 'finish the task', restoredUnconfirmed: true },
      undefined,
      { updatedAt: Date.now() - 5000 },
      { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: null },
      {
        providerSession: decodeHookResumeSession(
          { key: 'session_id', id: agent === 'claude' ? CLAUDE_ID : CODEX_ID },
          agent,
          null
        )
      }
    )
}

function coldRestore(): { command?: string; env?: Record<string, string> } | null {
  const reportError = vi.fn()
  const fake = {
    paneStartup: undefined,
    pendingStartupCommand: null,
    cacheKey: PANE,
    executionHostId: null,
    connectionId: null,
    projectRuntime: undefined,
    worktree: { path: '/tmp/wt-1' },
    shellOverride: undefined,
    reportError,
    getSleepingRecordForPane: (state: AppState) => {
      const record = state.sleepingAgentSessionsByPaneKey[PANE]
      return record ? { paneKey: PANE, record } : null
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cold-restore startup reads only the fields this fake supplies.
  const session = fake as unknown as ConnectPanePtySession
  bindBuildColdRestoreAgentResumeStartup(session)
  const startup = session.buildColdRestoreAgentResumeStartup()
  expect(reportError).not.toHaveBeenCalled()
  return startup
}

function wake(record: SleepingAgentSessionRecord): string | undefined {
  const createTab = vi.fn<AppState['createTab']>((worktreeId) =>
    makeTab({ id: 'resumed-tab', worktreeId })
  )
  currentStore().setState({ createTab })
  expect(launchSleepingAgentSession(record, { suppressNavigation: true })).toBe(true)
  return createTab.mock.calls.at(-1)?.[3]?.pendingStartup?.command
}

describe('launch settings across the resume-identity upgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
  })

  it('resumes a legacy record with the settings it was saved with', () => {
    const saved = {
      agentCommand: "/opt/custom/claude '--model' 'opus'",
      agentArgs: '--model opus',
      agentEnv: { MY_FLAG: '1' }
    }
    const record = restoreMainRecord('claude', saved)
    const expected = `/opt/custom/claude '--model' 'opus' '--resume' '${CLAUDE_ID}'`

    expect(coldRestore()).toMatchObject({ command: expected, env: { MY_FLAG: '1' } })
    expect(wake(record)).toBe(expected)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('resumes a legacy record with no saved settings using the current settings', () => {
    const record = restoreMainRecord('claude')
    const expected = `/opt/settings/claude '--settings-arg' '--resume' '${CLAUDE_ID}'`

    expect(coldRestore()).toMatchObject({ command: expected, env: { FROM_SETTINGS: '1' } })
    expect(wake(record)).toBe(expected)
  })

  it('keeps a legacy record settings when the saved hook row is replayed first', () => {
    restoreMainRecord('claude', {
      agentCommand: "/opt/custom/claude '--model' 'opus'",
      agentArgs: '--model opus',
      agentEnv: { MY_FLAG: '1' }
    })
    replayHookRow('claude')

    expect(
      currentStore().getState().agentStatusByPaneKey[PANE]?.providerSession?.resumeIdentity
    ).toEqual({ agent: 'claude' })
    expect(coldRestore()).toMatchObject({
      command: `/opt/custom/claude '--model' 'opus' '--resume' '${CLAUDE_ID}'`,
      env: { MY_FLAG: '1' }
    })
  })

  it('keeps settings captured at launch through quit, restart and hook-row replay', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: { codex: '/opt/custom/codex' },
      platform: 'linux',
      agentArgs: '--dangerously-bypass-approvals-and-sandbox',
      agentEnv: { MY_FLAG: '1' }
    })
    if (!plan) {
      throw new Error('Launch plan was not built')
    }
    let store = currentStore()
    store.getState().registerAgentLaunchConfig(PANE, plan.launchConfig, {
      agentType: 'codex',
      launchToken: 'tok'
    })
    store.getState().setAgentStatus(
      PANE,
      { agentType: 'codex', state: 'working', prompt: 'finish the task' },
      undefined,
      { updatedAt: Date.now() - 8000 },
      { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: null },
      {
        providerSession: decodeHookResumeSession(
          { key: 'session_id', id: CODEX_ID },
          'codex',
          null
        ),
        launchToken: 'tok'
      }
    )
    store.getState().captureAllSleepingAgentSessions('quit')
    const persisted = JSON.parse(JSON.stringify(store.getState().sleepingAgentSessionsByPaneKey))

    store = resetStore()
    const restored = sleepingAgentSessionsByPaneKeySchema.parse(persisted)
    if (!restored) {
      throw new Error('Sleeping records were discarded')
    }
    store.setState({ sleepingAgentSessionsByPaneKey: restored })
    replayHookRow('codex')
    const expected = `/opt/custom/codex '--dangerously-bypass-approvals-and-sandbox' 'resume' '${CODEX_ID}'`

    expect(coldRestore()).toMatchObject({ command: expected, env: { MY_FLAG: '1' } })
    store.setState({ agentStatusByPaneKey: {} })
    expect(coldRestore()).toMatchObject({ command: expected, env: { MY_FLAG: '1' } })
    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    if (!record) {
      throw new Error('Sleeping record was lost')
    }
    expect(record.providerSession.resumeIdentity).toEqual({ agent: 'codex' })
    expect(wake(record)).toBe(expected)
  })
})

// Records origin/main saved for a nested agent before resume identity existed: the pane shows
// one agent while the saved session (id + transcript path) is the nested agent's. The capture
// functions used here are unchanged from origin/main.
const CODEX_ROLLOUT = `/Users/example/codex-runtime-home/home/sessions/2026/09/30/rollout-2026-09-30T00-00-00-${CODEX_ID}.jsonl`
const CLAUDE_TRANSCRIPT = `/Users/example/.claude/projects/-Users-example-repo/${CLAUDE_ID}.jsonl`
const CODEX_WITH_CURRENT_SETTINGS = `/opt/settings/codex '--settings-arg' 'resume' '${CODEX_ID}'`

function showMainEraSession(
  displayAgent: 'claude' | 'codex',
  providerSession: SleepingAgentSessionRecord['providerSession']
): void {
  const store = currentStore()
  store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
  store
    .getState()
    .registerAgentLaunchConfig(
      PANE,
      { agentCommand: `/opt/custom/${displayAgent} --display-only`, agentArgs: '', agentEnv: {} },
      { agentType: displayAgent }
    )
  store
    .getState()
    .setAgentStatus(
      PANE,
      { agentType: displayAgent, state: 'working', prompt: 'finish the task' },
      undefined,
      { updatedAt: Date.now() - 5000 },
      { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: null },
      { providerSession }
    )
}

/** Quit, then restart: the saved hook row is reaped before any workspace opens. */
function quitAndRestart(): SleepingAgentSessionRecord {
  currentStore().getState().captureAllSleepingAgentSessions('quit')
  const persisted = JSON.parse(
    JSON.stringify(currentStore().getState().sleepingAgentSessionsByPaneKey)
  )
  const store = resetStore()
  const restored = sleepingAgentSessionsByPaneKeySchema.parse(persisted)
  const record = restored?.[PANE]
  if (!restored || !record) {
    throw new Error('Sleeping record was discarded')
  }
  store.setState({ sleepingAgentSessionsByPaneKey: restored })
  return record
}

function sleepWorktree(): SleepingAgentSessionRecord {
  currentStore().getState().captureSleepingAgentSessionsByWorktree('wt-1')
  const record = currentStore().getState().sleepingAgentSessionsByPaneKey[PANE]
  if (!record) {
    throw new Error('Sleeping record was not captured')
  }
  return record
}

describe('records saved before resume identity, owned by their transcript path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
  })

  it('cold-restores a quit Claude pane holding a nested Codex session in Codex', () => {
    showMainEraSession('claude', {
      key: 'session_id',
      id: CODEX_ID,
      transcriptPath: CODEX_ROLLOUT
    })
    const record = quitAndRestart()

    expect(record.providerSession.resumeIdentity).toBeUndefined()
    expect(coldRestore()).toMatchObject({
      command: CODEX_WITH_CURRENT_SETTINGS,
      env: { FROM_SETTINGS: '1' }
    })
  })

  it('wakes a slept Claude pane holding a nested Codex session in Codex', () => {
    showMainEraSession('claude', {
      key: 'session_id',
      id: CODEX_ID,
      transcriptPath: CODEX_ROLLOUT
    })
    const record = sleepWorktree()

    expect(record.agent).toBe('claude')
    expect(wake(record)).toBe(CODEX_WITH_CURRENT_SETTINGS)
  })

  it('wakes a Codex pane holding a nested Claude session in Claude', () => {
    showMainEraSession('codex', {
      key: 'session_id',
      id: CLAUDE_ID,
      transcriptPath: CLAUDE_TRANSCRIPT
    })

    expect(wake(sleepWorktree())).toBe(
      `/opt/settings/claude '--settings-arg' '--resume' '${CLAUDE_ID}'`
    )
  })

  it('keeps the display agent when the session has no transcript path, as before', () => {
    showMainEraSession('claude', { key: 'session_id', id: CODEX_ID })

    expect(wake(sleepWorktree())).toBe(`/opt/custom/claude --display-only '--resume' '${CODEX_ID}'`)
  })

  it('keeps the display agent when the path names another session', () => {
    showMainEraSession('claude', {
      key: 'session_id',
      id: CODEX_ID,
      transcriptPath: CODEX_ROLLOUT.replace(CODEX_ID, CLAUDE_ID)
    })

    expect(wake(sleepWorktree())).toBe(`/opt/custom/claude --display-only '--resume' '${CODEX_ID}'`)
  })

  it('lets the owner label win over the transcript path', () => {
    showMainEraSession('claude', {
      key: 'session_id',
      id: CODEX_ID,
      transcriptPath: CODEX_ROLLOUT,
      resumeIdentity: { agent: 'claude' }
    })

    expect(wake(sleepWorktree())).toBe(`/opt/custom/claude --display-only '--resume' '${CODEX_ID}'`)
  })
})
