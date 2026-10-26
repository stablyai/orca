import type { AppState } from '@/store/types'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { subscribeAgentStatusState } from '@/store/agent-status'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import type {
  AgentLaunchConfigRegistryEntry,
  AgentLaunchConfigRegistrationMetadata
} from '@/store/slices/agent-status-contract'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindSettlePaneSerializer } from './pane-serializer-settle'
import { bindDeferredColdRestoreAndSnapshot } from './deferred-cold-restore-and-snapshot'
import { installSleepingRecordAccess } from './sleeping-record-access'
import { createTestStore, makeTab } from '@/store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '@/store/slices/store-session-test-harness'
import {
  applyTerminalLaunchResult,
  captureTerminalLaunchContext
} from './terminal-launch-result-policy'

const fixture = vi.hoisted(() => {
  const activeStore: { getState?: () => AppState } = {}
  return {
    activeStore,
    state: {},
    setState: vi.fn(),
    paste: vi.fn(),
    parsed: vi.fn(async () => {})
  }
})
vi.mock('@/store', () => ({
  useAppStore: {
    get getState() {
      return fixture.activeStore.getState ?? (() => fixture.state)
    },
    setState: fixture.setState
  }
}))
vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  waitForTerminalOutputParsed: fixture.parsed
}))
vi.mock('../terminal-startup-command-paste', () => ({
  executeTerminalStartupCommandPaste: fixture.paste
}))
vi.mock('../terminal-paste-runtime', () => ({ resolveTerminalPasteRuntime: () => ({}) }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
vi.mock('./command-inferred-pane-agent', () => ({ installCommandInferredPaneAgent: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  fixture.setState.mockReset()
  fixture.activeStore.getState = undefined
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
      bindSettlePaneSerializer(session)
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
    fixture.activeStore.getState = store.getState
    fixture.setState.mockImplementation(store.setState)
    const owner = getAgentStatusOwner(store)
    let notifications = 0
    let rawNotifications = 0
    let canonicalNotifications = 0
    const unsubscribe = subscribeAgentStatusState(() => {
      notifications += 1
    }, store)
    const unsubscribeRaw = store.subscribe(() => {
      rawNotifications += 1
    })
    const unsubscribeCanonical = owner.subscribeAggregate(() => {
      canonicalNotifications += 1
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
      tabsByWorktree: { wt: tabs }
    })
    owner.transact((transaction) => {
      for (const [key, row] of Object.entries(population('tab:leaf', status))) {
        transaction.setEntry(key, row)
      }
    })
    const context = captureTerminalLaunchContext(session, startup)
    const successor = { ...startup, resumeSource: { cancelled: false } }
    const successorRegistration = { ...registration, registeredAt: 2 }
    if (newer) {
      session.paneStartup = successor
      session.pendingStartupCommand = successor
      store.setState({
        pendingStartupByTabId: counted(population('tab', successor)),
        automaticAgentResumeClaimsByTabId: counted(population('tab', { ...claim })),
        agentLaunchConfigByPaneKey: counted(population('tab:leaf', successorRegistration))
      })
    }
    if (newer) {
      owner.transact((transaction) => {
        for (const [key, row] of Object.entries(
          population('tab:leaf', { ...status, updatedAt: 2 })
        )) {
          transaction.setEntry(key, row)
        }
      })
    }
    let statusRowReads = 0
    let statusEnumerations = 0
    const armStatusMeasurement = () => {
      const snapshot = owner.getSnapshot()
      const descriptors = new Map<string, PropertyDescriptor>()
      for (const key of Object.keys(snapshot)) {
        if (key === 'tab:leaf') {
          continue
        }
        const descriptor = Object.getOwnPropertyDescriptor(snapshot, key)!
        const row = snapshot[key]
        descriptors.set(key, descriptor)
        Object.defineProperty(snapshot, key, {
          configurable: true,
          enumerable: true,
          get: () => {
            statusRowReads += 1
            return row
          }
        })
      }
      const keys = Object.keys
      const entries = Object.entries
      const values = Object.values
      const ownKeys = Reflect.ownKeys
      const spies = [
        vi.spyOn(Object, 'keys').mockImplementation((value) => {
          if (value === snapshot) {
            statusEnumerations += 1
          }
          return keys(value)
        }),
        vi.spyOn(Object, 'entries').mockImplementation((value) => {
          if (value === snapshot) {
            statusEnumerations += 1
          }
          return entries(value)
        }),
        vi.spyOn(Object, 'values').mockImplementation((value) => {
          if (value === snapshot) {
            statusEnumerations += 1
          }
          return values(value)
        }),
        vi.spyOn(Reflect, 'ownKeys').mockImplementation((value) => {
          if (value === snapshot) {
            statusEnumerations += 1
          }
          return ownKeys(value)
        })
      ]
      return () => {
        spies.forEach((spy) => spy.mockRestore())
        for (const [key, descriptor] of descriptors) {
          Object.defineProperty(snapshot, key, descriptor)
        }
      }
    }
    enumerated = 0
    copied = 0
    notifications = 0
    rawNotifications = 0
    canonicalNotifications = 0
    tabVisits = 0
    let restoreStatus = armStatusMeasurement()
    const result = {
      agentResumeRefused: 'chat-home' as const,
      savedResumeDecision: {
        agent: 'codex',
        providerSession: startup.resumeProviderSession,
        verdict: 'chat-home' as const
      }
    }
    try {
      const applied = applyTerminalLaunchResult(session, result, context, 'creator')
      restoreStatus()
      expect(applied).toBe(true)
      expect(source.cancelled).toBe(true)
      // Three app-map copies plus one canonical materialization, measured on the actual sources.
      expect([enumerated, copied, notifications, tabVisits]).toEqual(
        newer ? [0, 0, 0, 0] : [3 * size, 3 * size, 4, size]
      )
      expect([statusRowReads, statusEnumerations]).toEqual(newer ? [0, 0] : [size - 1, 0])
      expect([rawNotifications, canonicalNotifications]).toEqual(newer ? [0, 0] : [3, 1])
      const current = owner.getState()
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
      rawNotifications = 0
      canonicalNotifications = 0
      statusRowReads = 0
      statusEnumerations = 0
      restoreStatus = armStatusMeasurement()
      applyTerminalLaunchResult(session, result, context, 'creator')
      restoreStatus()
      expect([enumerated, copied, notifications, tabVisits]).toEqual([0, 0, 0, 0])
      expect([
        statusRowReads,
        statusEnumerations,
        rawNotifications,
        canonicalNotifications
      ]).toEqual([0, 0, 0, 0])
    } finally {
      restoreStatus()
      unsubscribe()
      unsubscribeRaw()
      unsubscribeCanonical()
    }
  }
})
