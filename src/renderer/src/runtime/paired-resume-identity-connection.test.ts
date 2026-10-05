/**
 * The resume identity names the provider only. Host scope stays with the record's connection,
 * checked against the pane's execution host, so a session whose hook route named a different
 * connection than the renderer row (WSL relay, paired runtime mirror) still resumes, as on main.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type { AppState } from '../store/types'
import type { ConnectPanePtySession } from '../components/terminal-pane/pty-connection/connect-pane-pty-session'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { getDefaultSettings } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { wslHookRelayConnectionId } from '../../../shared/wsl-hook-relay-contract'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { inheritAgentResumeIdentity } from '../../../shared/agent-resume-identity'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
import {
  applyFreshWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'
import { resolveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { bindBuildColdRestoreAgentResumeStartup } from '../components/terminal-pane/pty-connection/cold-restore-resume-startup'

type TestStore = ReturnType<typeof createTestStore>

const holder = vi.hoisted((): { store?: TestStore } => ({}))

function currentStore(): TestStore {
  if (!holder.store) {
    throw new Error('Test store not initialised')
  }
  return holder.store
}

vi.mock('../store', () => ({
  useAppStore: {
    getState: () => currentStore().getState(),
    setState: (partial: Partial<AppState>) => currentStore().setState(partial),
    subscribe: (listener: (state: AppState) => void) => currentStore().subscribe(listener)
  }
}))

const WT = 'repo1::/path/wt1'
const ENV = 'remote-env-1'
const T0 = 1_700_000_000_000
const HOST_TAB = 'host-tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const MIRRORED_PANE = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB), LEAF)

/** The provider session as the host's writer stamps it from a hook on `connectionId`, after the wire. */
function hostProviderSession(
  agent: 'claude' | 'codex',
  connectionId: string | null
): AgentProviderSessionMetadata {
  const event = normalizeHookPayload(
    createHookListenerState(),
    agent,
    {
      paneKey: makePaneKey(HOST_TAB, LEAF),
      tabId: HOST_TAB,
      worktreeId: WT,
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt: 'work' }
    },
    'production'
  )
  if (!event) {
    throw new Error('Hook was not normalized')
  }
  const stamped = inheritAgentResumeIdentity({ ...event, connectionId }, undefined, agent)
  const session = normalizeAgentProviderSession(JSON.parse(JSON.stringify(stamped.providerSession)))
  if (!session) {
    throw new Error('Provider session did not survive the wire')
  }
  return session
}

function snapshot(
  providerSession: AgentProviderSessionMetadata,
  connectionId?: string
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'e1',
    snapshotVersion: 1,
    activeGroupId: 'g1',
    activeTabId: `${HOST_TAB}::${LEAF}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${HOST_TAB}::${LEAF}`,
        title: 'Claude Code',
        parentTabId: HOST_TAB,
        leafId: LEAF,
        isActive: true,
        launchAgent: 'claude',
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: '',
          updatedAt: T0 - 1000,
          stateStartedAt: T0 - 2000,
          agentType: 'claude',
          paneKey: makePaneKey(HOST_TAB, LEAF),
          tabId: HOST_TAB,
          worktreeId: WT,
          stateHistory: [],
          providerSession,
          ...(connectionId !== undefined ? { connectionId } : {})
        }
      }
    ]
  }
}

function coldRestore(
  paneKey: string,
  executionHostId: string
): { startup: { command?: string } | null; reportError: ReturnType<typeof vi.fn> } {
  const reportError = vi.fn()
  const fake = {
    paneStartup: undefined,
    pendingStartupCommand: null,
    cacheKey: paneKey,
    executionHostId,
    connectionId: null,
    projectRuntime: undefined,
    worktree: { path: '/path/wt1' },
    shellOverride: undefined,
    reportError,
    getSleepingRecordForPane: () => null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cold-restore startup reads only the fields this fake supplies.
  const session = fake as unknown as ConnectPanePtySession
  bindBuildColdRestoreAgentResumeStartup(session)
  return { startup: session.buildColdRestoreAgentResumeStartup(), reportError }
}

describe('resume across a connection the renderer row does not repeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
    holder.store = createTestStore()
    seedStore(holder.store, {
      settings: { ...getDefaultSettings('/tmp'), agentDefaultArgs: {}, agentDefaultEnv: {} },
      worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
      activeWorktreeId: WT
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  it('resumes a Windows WSL pane whose hook route was wsl:<distro> and whose row is local', () => {
    const paneKey = makePaneKey('tab-1', LEAF)
    currentStore()
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: '', agentType: 'codex' },
        undefined,
        { updatedAt: T0 - 1000 },
        { tabId: 'tab-1', worktreeId: WT, connectionId: null },
        { providerSession: hostProviderSession('codex', wslHookRelayConnectionId('Ubuntu')) }
      )

    const { startup, reportError } = coldRestore(paneKey, LOCAL_EXECUTION_HOST_ID)
    expect(reportError).not.toHaveBeenCalled()
    expect(startup?.command).toContain("'resume' 'sess-1'")
  })

  it('resumes a paired-runtime mirror the client restamped with its environment', () => {
    const store = currentStore()
    store.setState(
      applyFreshWebSessionTabsSnapshot(
        store.getState(),
        snapshot(hostProviderSession('claude', null)),
        ENV,
        T0
      )
    )
    expect(store.getState().agentStatusByPaneKey[MIRRORED_PANE]?.connectionId).toBe(ENV)

    const { startup, reportError } = coldRestore(MIRRORED_PANE, toRuntimeExecutionHostId(ENV))
    expect(reportError).not.toHaveBeenCalled()
    expect(startup?.command).toContain("'--resume' 'sess-1'")
  })

  it('resumes a client-owned remote row that adopted the host SSH pane session', () => {
    const store = currentStore()
    const routing = resolveAgentStatusConnectionRouting({
      ptyId: `remote:${ENV}@@handle-1`,
      runtimeEnvironmentId: ENV
    })
    expect(routing).toEqual({ connectionId: null })
    registerRendererOwnedAgentStatusPane(MIRRORED_PANE, ENV)
    markRendererOwnedAgentStatusWrite(MIRRORED_PANE)
    store
      .getState()
      .setAgentStatus(
        MIRRORED_PANE,
        { state: 'working', prompt: '', agentType: 'claude' },
        'Claude Code',
        undefined,
        { connectionId: null, tabId: toWebTerminalSurfaceTabId(HOST_TAB), worktreeId: WT }
      )
    store.setState(
      applyFreshWebSessionTabsSnapshot(
        store.getState(),
        snapshot(hostProviderSession('claude', 'ssh-target-1'), 'ssh-target-1'),
        ENV,
        T0 + 10
      )
    )
    const entry = store.getState().agentStatusByPaneKey[MIRRORED_PANE]
    expect(entry?.connectionId).toBeNull()
    expect(entry?.providerSession).toMatchObject({
      id: 'sess-1',
      resumeIdentity: { agent: 'claude' }
    })

    const { startup, reportError } = coldRestore(MIRRORED_PANE, toRuntimeExecutionHostId(ENV))
    expect(reportError).not.toHaveBeenCalled()
    expect(startup?.command).toContain("'--resume' 'sess-1'")
  })

  it('still declines a row captured on another SSH host, through the host-scope check', () => {
    const paneKey = makePaneKey('tab-1', LEAF)
    currentStore()
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: '', agentType: 'claude' },
        undefined,
        { updatedAt: T0 - 1000 },
        { tabId: 'tab-1', worktreeId: WT, connectionId: 'ssh-other' },
        { providerSession: hostProviderSession('claude', 'ssh-other') }
      )

    const { startup, reportError } = coldRestore(paneKey, LOCAL_EXECUTION_HOST_ID)
    expect(startup).toBeNull()
    expect(reportError).not.toHaveBeenCalled()
  })
})
