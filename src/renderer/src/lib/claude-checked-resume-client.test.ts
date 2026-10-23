import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import { createStoreSessionMockApi } from '@/store/slices/store-session-test-harness'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { launchSleepingAgentSession } from './sleeping-agent-session-launch'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { bindBuildColdRestoreAgentResumeStartup } from '@/components/terminal-pane/pty-connection/cold-restore-resume-startup'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup } from '@/components/terminal-pane/pty-connection/fresh-spawn-types'
import { AGENT_SESSION_CLAUDE_CHECKED_RESUME_RUNTIME_CAPABILITY as CHECKED_RESUME } from '../../../shared/agent-session-resume-runtime-capabilities'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { RuntimeStatus } from '../../../shared/runtime-types'

const initial = useAppStore.getState()
const worktree = makeCreatedAgentWorktree()
const record: SleepingAgentSessionRecord = {
  paneKey: 'previous-tab:leaf',
  tabId: 'previous-tab',
  worktreeId: worktree.id,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'claude-a' },
  prompt: 'Continue',
  state: 'working',
  origin: 'live',
  capturedAt: 1,
  updatedAt: 1
}

function hostStatus(capabilities: RuntimeStatus['capabilities']): RuntimeStatus {
  return {
    runtimeId: 'server-a',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    capabilities
  }
}

function coldRestoreSession(executionHostId: string, runtimeEnvironmentId: string | null) {
  const candidate = {
    cacheKey: record.paneKey,
    pendingStartupCommand: null,
    deps: { worktreeId: worktree.id },
    executionHostId,
    transport: { getRuntimeEnvironmentId: () => runtimeEnvironmentId },
    getSleepingRecordForPane: () => ({ paneKey: record.paneKey, record }),
    reportError: vi.fn(),
    buildColdRestoreAgentResumeStartup: (): ColdRestoreAgentResumeStartup | null => null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this installer reads only these owner, startup and record fields; it never connects a PTY.
  const session = candidate as unknown as ConnectPanePtySession
  bindBuildColdRestoreAgentResumeStartup(session)
  return session
}

beforeEach(() => {
  vi.stubGlobal('window', undefined)
  createStoreSessionMockApi()
  seedEmptyActivatableWorktree(worktree)
  useAppStore.setState({
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
    automaticAgentResumeClaimsByTabId: {},
    agentStatusByPaneKey: {},
    runtimeStatusByEnvironmentId: new Map()
  })
  setLocalRuntimeCapabilitiesForTests([CHECKED_RESUME])
})
afterEach(() => {
  useAppStore.setState(initial, true)
  setLocalRuntimeCapabilitiesForTests(null)
  vi.unstubAllGlobals()
})

describe('Claude automatic restore host compatibility', () => {
  it.each([{ capabilities: null }, { capabilities: [] }] as const)(
    'keeps a local record without dispatching a resume when host capabilities are %s',
    ({ capabilities }) => {
      setLocalRuntimeCapabilitiesForTests(capabilities)
      expect(launchSleepingAgentSession(record)).toBe(false)
      expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toEqual([])
      expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
      const cold = coldRestoreSession('local', null)
      expect(cold.buildColdRestoreAgentResumeStartup()).toBeNull()
      expect(cold.reportError).toHaveBeenCalledWith(expect.stringContaining('original account'))
    }
  )

  it('uses the paired execution owner instead of this client capability', () => {
    useAppStore.setState({
      worktreesByRepo: { 'repo-1': [{ ...worktree, hostId: 'runtime:server-a' }] },
      runtimeStatusByEnvironmentId: new Map([
        ['server-a', { status: hostStatus([]), checkedAt: 1 }]
      ])
    })
    expect(launchSleepingAgentSession(record)).toBe(false)
    expect(coldRestoreSession('local', 'server-a').buildColdRestoreAgentResumeStartup()).toBeNull()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        ['server-a', { status: hostStatus([CHECKED_RESUME]), checkedAt: 2 }]
      ])
    })
    expect(
      coldRestoreSession('local', 'server-a').buildColdRestoreAgentResumeStartup()
    ).toMatchObject({
      agent: 'claude',
      resumeProviderSession: record.providerSession
    })
    expect(coldRestoreSession('local', null).buildColdRestoreAgentResumeStartup()).toBeNull()
  })

  it('refuses direct and paired SSH recovery even when its endpoint supports checked native restore', () => {
    useAppStore.setState({
      repos: useAppStore.getState().repos.map((repo) => ({
        ...repo,
        connectionId: 'ssh-a',
        executionHostId: 'ssh:ssh-a' as const
      })),
      worktreesByRepo: { 'repo-1': [{ ...worktree, hostId: 'ssh:ssh-a' }] }
    })
    expect(launchSleepingAgentSession(record)).toBe(false)
    expect(coldRestoreSession('ssh:ssh-a', null).buildColdRestoreAgentResumeStartup()).toBeNull()
    useAppStore.setState({
      repos: useAppStore
        .getState()
        .repos.map((repo) => ({ ...repo, executionHostId: 'runtime:server-a' as const })),
      worktreesByRepo: { 'repo-1': [{ ...worktree, hostId: 'runtime:server-a' }] },
      runtimeStatusByEnvironmentId: new Map([
        ['server-a', { status: hostStatus([CHECKED_RESUME]), checkedAt: 1 }]
      ])
    })
    expect(launchSleepingAgentSession(record)).toBe(false)
    expect(
      coldRestoreSession('ssh:ssh-a', 'server-a').buildColdRestoreAgentResumeStartup()
    ).toBeNull()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('retains the record while a new tab owns its pending restore, including repeated wake sweeps', () => {
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(1)
    const state = useAppStore.getState()
    const tab = state.tabsByWorktree[worktree.id]?.[0]
    expect(tab).toBeDefined()
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    expect(state.automaticAgentResumeClaimsByTabId[tab!.id]?.recoveryPaneKey).toBe(record.paneKey)
    state.consumeTabStartupCommand(tab!.id)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })
})
