import { bindBuildColdRestoreAgentResumeStartup } from './cold-restore-resume-startup'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentLaunchConfigRegistryEntry,
  AgentLaunchConfigRegistrationMetadata
} from '@/store/slices/agent-status/agent-status-contract'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { bindPaneSerializerReadiness } from '../serialization/pane-serializer-readiness'
import { bindStartupDraftPaste } from './startup-draft-paste'
import { bindSessionRestoredBannerAdmission } from '../notifications/session-restored-banner-admission'
import { bindDeferredColdRestoreAndSnapshot } from '../deferred-cold-restore-and-snapshot'
import { installSleepingRecordAccess } from './sleeping-record-access'
import { createTestStore } from '@/store/testing/app-store-test-fixture'

const fixture = vi.hoisted(() => ({
  state: {},
  setState: vi.fn(),
  paste: vi.fn(),
  parsed: vi.fn(async () => {})
}))
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => fixture.state, setState: fixture.setState }
}))
vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  waitForTerminalOutputParsed: fixture.parsed
}))
vi.mock('../../input/paste/terminal-startup-command-paste', () => ({
  executeTerminalStartupCommandPaste: fixture.paste
}))
vi.mock('../../input/paste/terminal-paste-runtime', () => ({
  resolveTerminalPasteRuntime: () => ({})
}))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
vi.mock('../agent-identity/command-inferred-pane-agent', () => ({
  installCommandInferredPaneAgent: vi.fn()
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  fixture.setState.mockReset()
  vi.unstubAllGlobals()
})

describe('a refused saved startup and its delayed paste', () => {
  it.each(['original', 'same-C', 'different-D', 'unverifiable'] as const)(
    'cancels only its captured source and keeps newer work (%s)',
    async (kind) => {
      vi.useFakeTimers()
      const record = {
        paneKey: 'tab:leaf',
        tabId: 'tab',
        worktreeId: 'wt',
        agent: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: 'C' },
        connectionId: null,
        state: 'done' as const,
        prompt: '',
        capturedAt: 10,
        updatedAt: 10,
        origin: 'worktree-sleep' as const
      }
      const source = { cancelled: false, record }
      const startup = {
        command: 'codex resume C',
        launchAgent: 'codex' as const,
        resumeProviderSession: record.providerSession,
        resumeOrigin: 'saved' as const,
        resumeSource: source
      }
      const records = kind === 'unverifiable' ? {} : { [record.paneKey]: record }
      const clear = vi.fn()
      const remember = vi.fn()
      fixture.state = {
        sleepingAgentSessionsByPaneKey: records,
        automaticAgentResumeClaimsByTabId: {},
        agentLaunchConfigByPaneKey: {},
        pendingStartupByTabId: {},
        tabsByWorktree: {},
        registerAgentLaunchConfig: vi.fn(),
        clearAgentLaunchConfig: vi.fn(),
        consumeTabStartupCommand: vi.fn(),
        clearSleepingAgentSession: clear,
        rememberSleepingAgentSession: remember
      }
      const sendInput = vi.fn(() => true)
      const transport = { getPtyId: () => 'shell', sendInput }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installers' accessed session members are supplied here.
      const session = {
        pane: { id: 1, leafId: 'leaf', terminal: {} },
        manager: {},
        transport,
        deps: {
          worktreeId: 'wt',
          tabId: 'tab',
          paneTransportsRef: { current: new Map([[1, transport]]) }
        },
        cacheKey: record.paneKey,
        paneStartup: startup,
        startupInjectTimer: null,
        disposed: false,
        transportStreamGeneration: 1,
        shouldDeliverStartupViaTerminalPaste: true,
        releaseUnattemptedStartupDraftPasteDelivery: vi.fn()
      } as unknown as ConnectPanePtySession
      installSleepingRecordAccess(session)
      bindPaneSerializerReadiness(session)
      bindStartupDraftPaste(session)
      bindSessionRestoredBannerAdmission(session)
      bindDeferredColdRestoreAndSnapshot(session)
      let finishPaste: (() => void) | undefined
      fixture.paste.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishPaste = () => resolve({ status: 'pasted' })
          })
      )
      session.schedulePendingStartupCommandDelivery()
      await vi.advanceTimersByTimeAsync(50)
      expect(fixture.paste).toHaveBeenCalledOnce()

      const newer = { command: kind === 'different-D' ? 'codex resume D' : 'codex resume C' }
      session.pendingStartupCommand = newer
      if (kind === 'same-C' || kind === 'different-D') {
        Object.assign(records, {
          [record.paneKey]: {
            ...record,
            providerSession: { ...record.providerSession, id: kind === 'same-C' ? 'C' : 'D' },
            updatedAt: 20
          }
        })
      }
      session.cancelSavedResumeStartup(startup, {
        id: 'shell',
        agentResumeRefused: kind === 'unverifiable' ? 'unverifiable' : 'chat-home'
      })
      expect(source.cancelled).toBe(true)
      expect(session.pendingStartupCommand).toBe(newer)
      finishPaste?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(sendInput).not.toHaveBeenCalled()
      expect(session.pendingStartupCommand).toBe(newer)
      if (kind === 'unverifiable') {
        expect(remember).toHaveBeenCalledWith(record)
      } else if (kind === 'original') {
        expect(clear).toHaveBeenCalledWith(record.paneKey)
      } else {
        expect(clear).not.toHaveBeenCalled()
      }
    }
  )
})

it.each(['refused', 'same-C', 'different-D'] as const)(
  'clears the real generated cold/wake registration and conditional tab identity only while owned (%s)',
  (kind) => {
    const cacheKey = 'tab:leaf'
    const source = { cancelled: false }
    const startup: ColdRestoreAgentResumeStartup = {
      agent: 'codex',
      command: 'codex resume C',
      launchToken: 'saved-token',
      launchConfig: { agentCommand: 'codex', agentArgs: 'resume C', agentEnv: {} },
      resumeProviderSession: { key: 'session_id', id: 'C' },
      resumeOrigin: 'saved',
      resumeSource: source,
      useLiveEntry: false,
      hasSleepingRecord: false,
      sleepingRecordEntry: null
    }
    const registry: Record<string, AgentLaunchConfigRegistryEntry> = {}
    const pending: Record<string, object> = {}
    const tab = { id: 'tab', title: 'Codex', launchAgent: 'codex', generation: 1 }
    const clearTabLaunchAgent = vi.fn()
    const registerAgentLaunchConfig = (
      paneKey: string,
      launchConfig: AgentLaunchConfigRegistryEntry['launchConfig'],
      identity: AgentLaunchConfigRegistrationMetadata
    ) => {
      registry[paneKey] = { launchConfig, identity, registeredAt: 1 }
    }
    fixture.state = {
      agentLaunchConfigByPaneKey: registry,
      pendingStartupByTabId: pending,
      automaticAgentResumeClaimsByTabId: {},
      sleepingAgentSessionsByPaneKey: {},
      tabsByWorktree: { wt: [tab] },
      registerAgentLaunchConfig,
      clearAgentLaunchConfig: (key: string) => {
        delete registry[key]
      },
      consumeTabStartupCommand: vi.fn(),
      clearTabLaunchAgent
    }
    const updateTabTitle = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real installers/cancellation access only the supplied session members in this contract.
    const session = {
      cacheKey,
      paneStartup: null,
      pane: { id: 1, leafId: 'leaf' },
      manager: { getActivePane: () => ({ id: 1 }) },
      deps: { tabId: 'tab', worktreeId: 'wt', setRuntimePaneTitle: vi.fn(), updateTabTitle },
      tabGeneration: 1,
      startupInjectTimer: null,
      transport: {},
      shouldDeliverStartupViaTerminalPaste: false
    } as unknown as ConnectPanePtySession
    installSleepingRecordAccess(session)
    bindDeferredColdRestoreAndSnapshot(session)
    expect(session.applyColdRestoreAgentResumeStartup(startup)).toBe(true)
    const saved = registry[cacheKey]
    expect(saved?.identity.launchToken).toBe('saved-token')
    if (kind !== 'refused') {
      const command = kind === 'same-C' ? 'resume C' : 'resume D'
      registerAgentLaunchConfig(
        cacheKey,
        { ...startup.launchConfig, agentArgs: command },
        {
          agentType: 'codex',
          launchToken: 'explicit-token'
        }
      )
      pending.tab = { command }
    }
    const current = registry[cacheKey]
    const newer = pending.tab
    session.cancelSavedResumeStartup(startup, { id: 'shell', agentResumeRefused: 'chat-home' })
    session.registerEffectiveLaunchConfig(undefined, {})
    expect(source.cancelled).toBe(true)
    expect(session.paneStartup).toBeNull()
    if (kind === 'refused') {
      expect(registry[cacheKey]).toBeUndefined()
      expect(clearTabLaunchAgent).toHaveBeenCalledWith('tab')
      expect(updateTabTitle).toHaveBeenCalledWith('tab', 'Terminal')
    } else {
      expect(registry[cacheKey]).toBe(current)
      expect(pending.tab).toBe(newer)
      expect(clearTabLaunchAgent).not.toHaveBeenCalled()
      expect(updateTabTitle).not.toHaveBeenCalled()
    }
  }
)

it.each(['canonical', 'legacy', 'live'] as const)(
  'does not recreate a confirmed-exited cold-restore source (%s)',
  (kind) => {
    const store = createTestStore()
    fixture.state = store.getState()
    const unsubscribe = store.subscribe((state) => {
      fixture.state = state
    })
    const paneKey = 'tab:leaf'
    const record = {
      paneKey: kind === 'legacy' ? 'tab:1' : paneKey,
      tabId: 'tab',
      worktreeId: 'wt',
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'C' },
      prompt: '',
      state: 'done' as const,
      capturedAt: 1,
      updatedAt: 1
    }
    store.getState().rememberSleepingAgentSession(record)
    const startup: ColdRestoreAgentResumeStartup = {
      agent: 'codex',
      command: 'codex resume C',
      launchToken: 'token',
      launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
      resumeProviderSession: record.providerSession,
      resumeOrigin: 'saved',
      resumeSource: {
        cancelled: false,
        record,
        expectedStatus: { paneKey, receivedAt: 1, stateStartedAt: 1 }
      },
      useLiveEntry: kind === 'live',
      hasSleepingRecord: kind !== 'live',
      sleepingRecordEntry: kind === 'live' ? null : { paneKey: record.paneKey, record }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only binding and retention run; all their accessed members are supplied.
    const session = {
      cacheKey: paneKey,
      deps: { tabId: 'tab', worktreeId: 'wt' },
      pane: { id: 1, leafId: 'leaf' },
      manager: {},
      paneStartup: null
    } as unknown as ConnectPanePtySession
    installSleepingRecordAccess(session)
    bindDeferredColdRestoreAndSnapshot(session)
    store.getState().clearSleepingAgentSession(record.paneKey)
    session.keepResumeRecordAfterColdRestoreSpawn(startup)
    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    unsubscribe()
  }
)

it.each([
  {
    liveId: 'C',
    savedId: 'C',
    savedHost: 'ssh-A',
    liveHost: undefined,
    expected: 'ssh-A',
    host: 'ssh:ssh-A'
  },
  {
    liveId: 'D',
    savedId: 'C',
    savedHost: 'ssh-A',
    liveHost: undefined,
    expected: undefined,
    host: 'ssh:ssh-A'
  },
  { liveId: 'C', savedId: 'C', savedHost: null, liveHost: null, expected: null, host: 'local' }
])('retains only matching captured host evidence ($liveId, $savedHost, $liveHost)', (testCase) => {
  const store = createTestStore()
  fixture.state = store.getState()
  const unsubscribe = store.subscribe((state) => {
    fixture.state = state
  })
  const paneKey = 'tab:leaf'
  store.setState({
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        agentType: 'codex',
        state: 'working',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: [],
        connectionId: testCase.liveHost,
        providerSession: { key: 'session_id', id: testCase.liveId }
      }
    },
    sleepingAgentSessionsByPaneKey: {
      [paneKey]: {
        paneKey,
        worktreeId: 'wt',
        agent: 'codex',
        state: 'working',
        prompt: '',
        updatedAt: 1,
        capturedAt: 1,
        connectionId: testCase.savedHost,
        providerSession: { key: 'session_id', id: testCase.savedId }
      }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only startup construction and retention run; all accessed session members are supplied.
  const session = {
    cacheKey: paneKey,
    deps: { tabId: 'tab', worktreeId: 'wt' },
    pane: { id: 1, leafId: 'leaf' },
    manager: {},
    paneStartup: null,
    worktree: { path: '/tmp' },
    executionHostId: testCase.host,
    transport: { getRuntimeEnvironmentId: () => null }
  } as unknown as ConnectPanePtySession
  installSleepingRecordAccess(session)
  bindBuildColdRestoreAgentResumeStartup(session)
  bindDeferredColdRestoreAndSnapshot(session)
  const startup = session.buildColdRestoreAgentResumeStartup()
  expect(startup).not.toBeNull()
  session.keepResumeRecordAfterColdRestoreSpawn(startup)
  expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]?.connectionId).toBe(
    testCase.expected
  )
  unsubscribe()
})
