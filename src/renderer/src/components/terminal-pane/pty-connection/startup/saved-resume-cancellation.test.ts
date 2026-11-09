import { bindBuildColdRestoreAgentResumeStartup } from './cold-restore-resume-startup'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
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
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { createStoreSessionMockApi } from '@/store/testing/app-store-session-api.test-fixture'
import {
  applyTerminalLaunchResult,
  captureTerminalLaunchContext
} from './terminal-launch-result-policy'

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

it.each([10, 100])('counts real saved-startup cancellation map work at %i entries', (size) => {
  vi.stubGlobal('window', undefined)
  createStoreSessionMockApi()
  for (const newer of [true, false]) {
    const store = createTestStore()
    fixture.state = store.getState()
    fixture.setState.mockImplementation(store.setState)
    let notifications = 0
    const unsubscribe = store.subscribe((state) => {
      fixture.state = state
      notifications += 1
    })
    const source = { cancelled: false }
    const startup = {
      command: 'codex resume C',
      launchAgent: 'codex' as const,
      launchToken: 'saved-token',
      launchConfig: { agentCommand: 'codex', agentArgs: 'resume C', agentEnv: {} },
      resumeProviderSession: { key: 'session_id' as const, id: 'C' },
      resumeOrigin: 'saved' as const,
      resumeSource: source
    }
    const claim = {
      worktreeId: 'wt',
      launchAgent: 'codex' as const,
      providerSession: startup.resumeProviderSession
    }
    const status: AgentStatusEntry = {
      paneKey: 'tab:leaf',
      state: 'done',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: []
    }
    store.setState({ automaticAgentResumeClaimsByTabId: { tab: claim } })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the actual installers/result policy access only these supplied session members.
    const session = {
      cacheKey: 'tab:leaf',
      pane: { id: 1, leafId: 'leaf' },
      paneStartup: startup,
      pendingStartupCommand: startup,
      startupInjectTimer: null,
      deps: { tabId: 'tab', worktreeId: 'wt' },
      showSessionRestoredBanner: vi.fn()
    } as unknown as ConnectPanePtySession
    installSleepingRecordAccess(session)
    const registration = store.getState().agentLaunchConfigByPaneKey['tab:leaf']!
    session.savedStartupStatus = { source, entry: status }
    let enumerated = 0
    let copied = 0
    const counted = <T extends object>(map: T): T =>
      new Proxy(map, {
        ownKeys(target) {
          const keys = Reflect.ownKeys(target)
          enumerated += keys.length
          return keys
        },
        getOwnPropertyDescriptor(target, key) {
          const descriptor = Object.getOwnPropertyDescriptor(target, key)
          if (descriptor?.enumerable) {
            copied += 1
          }
          return descriptor
        }
      })
    const population = <T>(target: string, value: T) =>
      Object.fromEntries(
        Array.from({ length: size }, (_, index) => [
          index === size - 1 ? target : `other-${index}`,
          value
        ])
      )
    let tabVisits = 0
    const tabs = Array.from({ length: size }, (_, index) =>
      makeTab({
        id: index === size - 1 ? 'tab' : `other-${index}`,
        worktreeId: 'wt'
      })
    )
    // Keep the real tab objects; count the actual find predicate's identity reads.
    tabs.forEach((tab, index) =>
      Object.defineProperty(tab, 'id', {
        get: () => {
          tabVisits += 1
          return index === size - 1 ? 'tab' : `other-${index}`
        }
      })
    )
    store.setState({
      pendingStartupByTabId: counted(population('tab', startup)),
      automaticAgentResumeClaimsByTabId: counted(population('tab', claim)),
      agentLaunchConfigByPaneKey: counted(population('tab:leaf', registration)),
      agentStatusByPaneKey: counted(population('tab:leaf', status)),
      tabsByWorktree: { wt: tabs }
    })
    const accepted = vi.fn()
    const disposeAccepted = store.getState().subscribeAgentStatusChanges(accepted)
    const context = captureTerminalLaunchContext(session, startup)
    const successor = { ...startup, resumeSource: { cancelled: false } }
    const successorRegistration = { ...registration, registeredAt: 2 }
    if (newer) {
      session.paneStartup = successor
      session.pendingStartupCommand = successor
      store.setState({
        pendingStartupByTabId: counted(population('tab', successor)),
        automaticAgentResumeClaimsByTabId: counted(population('tab', { ...claim })),
        agentLaunchConfigByPaneKey: counted(population('tab:leaf', successorRegistration)),
        agentStatusByPaneKey: counted(population('tab:leaf', { ...status, updatedAt: 2 }))
      })
    }
    enumerated = 0
    copied = 0
    notifications = 0
    tabVisits = 0
    const result = {
      agentResumeRefused: 'chat-home' as const,
      savedResumeDecision: {
        agent: 'codex',
        providerSession: startup.resumeProviderSession,
        verdict: 'chat-home' as const
      }
    }
    try {
      expect(applyTerminalLaunchResult(session, result, context, 'creator')).toBe(true)
      expect(source.cancelled).toBe(true)
      if (newer) {
        expect(accepted).not.toHaveBeenCalled()
      } else {
        expect(accepted).toHaveBeenCalledExactlyOnceWith([
          { paneKey: 'tab:leaf', previous: status, current: undefined }
        ])
      }
      // Four independent whole-map spreads, once each; this is work per result, not a latency bound.
      expect([enumerated, copied, notifications, tabVisits]).toEqual(
        newer ? [0, 0, 0, 0] : [4 * size, 4 * size, 4, size]
      )
      const current = store.getState()
      if (newer) {
        expect(current.pendingStartupByTabId.tab).toBe(successor)
        expect(current.agentLaunchConfigByPaneKey['tab:leaf']).toBe(successorRegistration)
        expect(current.automaticAgentResumeClaimsByTabId.tab).not.toBe(claim)
        expect(current.agentStatusByPaneKey['tab:leaf']?.updatedAt).toBe(2)
        expect(session.paneStartup).toBe(successor)
        expect(successor.resumeSource.cancelled).toBe(false)
      } else {
        expect(current.pendingStartupByTabId.tab).toBeUndefined()
        expect(current.agentLaunchConfigByPaneKey['tab:leaf']).toBeUndefined()
        expect(current.automaticAgentResumeClaimsByTabId.tab).toBeUndefined()
        expect(current.agentStatusByPaneKey['tab:leaf']).toBeUndefined()
        expect(current.pendingStartupByTabId['other-0']).toBe(startup)
        expect(session.pendingStartupCommand).toBeNull()
      }
      enumerated = 0
      copied = 0
      notifications = 0
      tabVisits = 0
      applyTerminalLaunchResult(session, result, context, 'creator')
      expect([enumerated, copied, notifications, tabVisits]).toEqual([0, 0, 0, 0])
    } finally {
      disposeAccepted()
      unsubscribe()
    }
  }
})

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
