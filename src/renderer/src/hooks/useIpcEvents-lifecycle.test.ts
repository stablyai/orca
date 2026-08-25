import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { createHarnessStoreState } from './ipc-events-test-harness'
const EXPECTED_DIRECT_CALLBACK_METHODS = [
  'agentStatus.onClear',
  'agentStatus.onLegacyWorkerTerminalRecovery',
  'agentStatus.onMigrationUnsupported',
  'agentStatus.onMigrationUnsupportedClear',
  'agentStatus.onSet',
  'browser.onActivateView',
  'browser.onCertificateFailureChanged',
  'browser.onGuestLoadFailed',
  'browser.onNavigationUpdate',
  'browser.onOpenLinkInOrcaTab',
  'browser.onPaneFocus',
  'emulator.onAutoAttach',
  'emulator.onPaneFocus',
  'gh.onPRRefreshEvent',
  'keybindings.onChanged',
  'rateLimits.onUpdate',
  'remoteWorkspace.onChanged',
  'repos.onChanged',
  'runtime.onBrowserDriverChanged',
  'runtime.onBrowserRemoteViewersChanged',
  'runtime.onClientHostedBrowserRowsChanged',
  'runtime.onNativeChatLaunchDraftResolved',
  'runtime.onTerminalDriverChanged',
  'runtime.onTerminalFitOverrideChanged',
  'settings.onChanged',
  'ssh.onCredentialRequest',
  'ssh.onCredentialResolved',
  'ssh.onDetectedPortsChanged',
  'ssh.onPortForwardsChanged',
  'ssh.onStateChanged',
  'ui.onActivateWorktree',
  'ui.onCloseActiveTab',
  'ui.onCloseFloatingItem',
  'ui.onCloseSessionTab',
  'ui.onCloseTerminal',
  'ui.onCreateTerminal',
  'ui.onDeleteCurrentWorkspace',
  'ui.onFocusEditorTab',
  'ui.onFocusTerminal',
  'ui.onFullscreenChanged',
  'ui.onJumpToTabIndex',
  'ui.onJumpToWorktreeIndex',
  'ui.onMoveSessionTab',
  'ui.onNewBrowserTab',
  'ui.onNewMarkdownTab',
  'ui.onNewSimulatorTab',
  'ui.onNewTerminalTab',
  'ui.onOpenDiffFromMobile',
  'ui.onOpenFeatureTour',
  'ui.onOpenFileFromMobile',
  'ui.onOpenNewWorkspace',
  'ui.onOpenQuickOpen',
  'ui.onOpenSettings',
  'ui.onOpenSetupGuide',
  'ui.onOpenSkillShare',
  'ui.onOpenTasks',
  'ui.onOpenWorkspaceBoard',
  'ui.onRenameTerminal',
  'ui.onRequestTabClose',
  'ui.onRequestTabCreate',
  'ui.onRequestTabSetProfile',
  'ui.onRequestTerminalCreate',
  'ui.onRequestTerminalTabMount',
  'ui.onResumeSleepingAgents',
  'ui.onSelectFloatingIndex',
  'ui.onSessionTabCloseRequest',
  'ui.onSleepWorktree',
  'ui.onSplitTerminal',
  'ui.onStateChanged',
  'ui.onSwitchRecentTab',
  'ui.onSwitchTab',
  'ui.onSwitchTabAcrossAllTypes',
  'ui.onSwitchTerminalTab',
  'ui.onSystemResumed',
  'ui.onTerminalShortcutCaptured',
  'ui.onTerminalTabCloseRequest',
  'ui.onTerminalZoom',
  'ui.onToggleAgentDashboard',
  'ui.onToggleFloatingTerminal',
  'ui.onToggleLeftSidebar',
  'ui.onToggleQuickCommandsMenu',
  'ui.onToggleRightSidebar',
  'ui.onToggleStatusBar',
  'ui.onToggleWorktreePalette',
  'ui.onWorktreeHistoryNavigate',
  'updater.onClearDismissal',
  'updater.onStatus',
  'workspaceSpace.onProgress',
  'worktrees.onBaseStatus',
  'worktrees.onChanged',
  'worktrees.onCreateProgress',
  'worktrees.onHeadIdentitiesChanged',
  'worktrees.onRemoteBranchConflict'
] as const

const EXPECTED_CALLBACK_REGISTRATION_SEQUENCE = [
  'ui.onMobileMarkdownRequest',
  'repos.onChanged',
  'worktrees.onChanged',
  'worktrees.onHeadIdentitiesChanged',
  'worktrees.onBaseStatus',
  'worktrees.onRemoteBranchConflict',
  'worktrees.onCreateProgress',
  'gh.onPRRefreshEvent',
  'ui.onOpenSettings',
  'ui.onOpenSkillShare',
  'ui.onOpenSetupGuide',
  'mobile.onUnpairedDeviceAuthFailure',
  'ui.onOpenFeatureTour',
  'settings.onChanged',
  'ui.onStateChanged',
  'keybindings.onChanged',
  'ui.onToggleLeftSidebar',
  'ui.onToggleRightSidebar',
  'ui.onToggleWorktreePalette',
  'ui.onToggleFloatingTerminal',
  'ui.onTerminalShortcutCaptured',
  'ui.onOpenQuickOpen',
  'ui.onToggleQuickCommandsMenu',
  'ui.onOpenNewWorkspace',
  'ui.onDeleteCurrentWorkspace',
  'ui.onOpenWorkspaceBoard',
  'ui.onToggleAgentDashboard',
  'ui.onOpenTasks',
  'ui.onJumpToWorktreeIndex',
  'ui.onJumpToTabIndex',
  'ui.onWorktreeHistoryNavigate',
  'ui.onToggleStatusBar',
  'ui.onActivateWorktree',
  'ui.onCreateTerminal',
  'ui.onRequestTerminalTabMount',
  'ui.onRequestTerminalCreate',
  'ui.onSplitTerminal',
  'ui.onRenameTerminal',
  'ui.onFocusTerminal',
  'ui.onFocusEditorTab',
  'ui.onCloseSessionTab',
  'ui.onSessionTabCloseRequest',
  'ui.onMoveSessionTab',
  'ui.onOpenFileFromMobile',
  'ui.onOpenDiffFromMobile',
  'ui.onCloseTerminal',
  'ui.onTerminalTabCloseRequest',
  'ui.onSleepWorktree',
  'ui.onResumeSleepingAgents',
  'updater.onStatus',
  'updater.onClearDismissal',
  'ui.onFullscreenChanged',
  'browser.onGuestLoadFailed',
  'browser.onCertificateFailureChanged',
  'browser.onNavigationUpdate',
  'browser.onActivateView',
  'browser.onPaneFocus',
  'browser.onOpenLinkInOrcaTab',
  'ui.onNewBrowserTab',
  'ui.onNewMarkdownTab',
  'ui.onNewSimulatorTab',
  'emulator.onAutoAttach',
  'emulator.onPaneFocus',
  'ui.onRequestTabCreate',
  'ui.onRequestTabSetProfile',
  'ui.onRequestTabClose',
  'ui.onNewTerminalTab',
  'ui.onCloseActiveTab',
  'ui.onCloseFloatingItem',
  'ui.onSelectFloatingIndex',
  'ui.onSwitchTab',
  'ui.onSwitchTabAcrossAllTypes',
  'ui.onSwitchRecentTab',
  'ui.onSwitchTerminalTab',
  'rateLimits.onUpdate',
  'workspaceSpace.onProgress',
  'ssh.onCredentialRequest',
  'ssh.onCredentialResolved',
  'ssh.onPortForwardsChanged',
  'ssh.onDetectedPortsChanged',
  'ssh.onStateChanged',
  'ui.onSystemResumed',
  'remoteWorkspace.onChanged',
  'ui.onTerminalZoom',
  'agentStatus.onSet',
  'agentStatus.onClear',
  'agentStatus.onMigrationUnsupported',
  'agentStatus.onMigrationUnsupportedClear',
  'agentStatus.onLegacyWorkerTerminalRecovery',
  'runtime.onTerminalFitOverrideChanged',
  'runtime.onTerminalDriverChanged',
  'runtime.onNativeChatLaunchDraftResolved',
  'runtime.onBrowserDriverChanged',
  'runtime.onBrowserRemoteViewersChanged',
  'runtime.onClientHostedBrowserRowsChanged'
] as const

type ListenerRecord = {
  callback: (...args: unknown[]) => void
  active: boolean
  cleanup: Mock
}

describe('useIpcEvents App-lifetime lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.doUnmock('./ipc-events/app-lifetime-ipc-bridge')
  })

  it('owns one empty-dependency React effect', async () => {
    let dependencies: readonly unknown[] | undefined
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return {
        ...actual,
        useEffect: (_effect: () => void | (() => void), nextDependencies?: readonly unknown[]) => {
          dependencies = nextDependencies
        }
      }
    })
    vi.doMock('./ipc-events/app-lifetime-ipc-bridge', () => ({
      installAppLifetimeIpcEvents: vi.fn(() => vi.fn())
    }))

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    expect(dependencies).toEqual([])
  })

  it('leaves exactly one listener per channel across a StrictMode cleanup-remount cycle', async () => {
    const registrationOrder: string[] = []
    const cleanupOrder: string[] = []
    const listeners = new Map<string, ListenerRecord[]>()
    const storeSubscriptions: { active: boolean; cleanup: Mock }[] = []
    const setUpdateStatus = vi.fn()
    const storeState = new Proxy(
      createHarnessStoreState({
        tabsByWorktree: { 'wt-1': [] },
        setUpdateStatus,
        workspaceSessionReady: true,
        runtimeEnvironments: [{ id: 'runtime-1' }],
        runtimeStatusByEnvironmentId: new Map([['runtime-1', { status: 'connected' }]])
      }),
      {
        get: (target, property: string) =>
          property in target ? target[property] : property.startsWith('set') ? vi.fn() : undefined
      }
    )

    vi.doMock('../store', () => ({
      useAppStore: {
        getState: () => storeState,
        subscribe: vi.fn(() => {
          const record = { active: true, cleanup: vi.fn() }
          const subscriptionIndex = storeSubscriptions.length
          storeSubscriptions.push(record)
          return () => {
            cleanupOrder.push(`store.unsubscribe.${subscriptionIndex}`)
            record.active = false
            record.cleanup()
          }
        })
      }
    }))

    const namespace = (name: string): Record<string, unknown> =>
      new Proxy(
        {},
        {
          get: (_target, property: string) => {
            if (name === 'runtimeEnvironments' && property === 'subscribe') {
              return async () => {
                registrationOrder.push('runtimeEnvironments.subscribe')
                return {
                  unsubscribe: () => cleanupOrder.push('runtimeEnvironment.unsubscribe')
                }
              }
            }
            if (property.startsWith('on')) {
              return (callback: (...args: unknown[]) => void) => {
                registrationOrder.push(`${name}.${property}`)
                const record: ListenerRecord = { callback, active: true, cleanup: vi.fn() }
                const records = listeners.get(`${name}.${property}`) ?? []
                records.push(record)
                listeners.set(`${name}.${property}`, records)
                return () => {
                  cleanupOrder.push(`ipc.${name}.${property}`)
                  record.active = false
                  record.cleanup()
                }
              }
            }
            if (property === 'getStatus') {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve({ state: 'idle' })
              }
            }
            if (property === 'get') {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve({ limits: {}, lastUpdatedAt: 0 })
              }
            }
            if (property === 'getState') {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve(null)
              }
            }
            if (property === 'clientId') {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve(null)
              }
            }
            if (property.startsWith('get') || property.startsWith('list')) {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve([])
              }
            }
            if (property.startsWith('consumePending')) {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve(null)
              }
            }
            return vi.fn()
          }
        }
      )
    const api = new Proxy(
      {},
      { get: (_target, property: string) => namespace(property) }
    ) as unknown
    vi.stubGlobal('window', {
      api,
      dispatchEvent: vi.fn(),
      setTimeout,
      clearTimeout
    })

    const { installAppLifetimeIpcEvents } = await import('./ipc-events/app-lifetime-ipc-bridge')
    const recordCleanupPhase = (phase: string): void => {
      cleanupOrder.push(phase)
    }
    const firstCleanup = installAppLifetimeIpcEvents(recordCleanupPhase)
    await Promise.resolve()
    await Promise.resolve()
    const directCallbackMethods = [...listeners.keys()]
      .filter(
        (method) =>
          method !== 'mobile.onUnpairedDeviceAuthFailure' && method !== 'ui.onMobileMarkdownRequest'
      )
      .sort()
    expect(directCallbackMethods).toEqual(EXPECTED_DIRECT_CALLBACK_METHODS)
    expect([...listeners.keys()].sort()).toEqual(
      [...EXPECTED_CALLBACK_REGISTRATION_SEQUENCE].sort()
    )
    expect(
      registrationOrder.filter(
        (entry) =>
          entry === 'runtimeEnvironments.subscribe' ||
          EXPECTED_CALLBACK_REGISTRATION_SEQUENCE.includes(
            entry as (typeof EXPECTED_CALLBACK_REGISTRATION_SEQUENCE)[number]
          )
      )
    ).toEqual([
      'ui.onMobileMarkdownRequest',
      'runtimeEnvironments.subscribe',
      ...EXPECTED_CALLBACK_REGISTRATION_SEQUENCE.slice(1)
    ])
    const groupOrder = (names: readonly string[]): string[] =>
      registrationOrder.filter((entry) => names.includes(entry))
    expect(
      groupOrder([
        'ui.onOpenSettings',
        'ui.onOpenSkillShare',
        'ui.consumePendingOpenSettings',
        'ui.consumePendingSkillShare'
      ])
    ).toEqual([
      'ui.onOpenSettings',
      'ui.onOpenSkillShare',
      'ui.consumePendingOpenSettings',
      'ui.consumePendingSkillShare'
    ])
    expect(
      groupOrder([
        'updater.getStatus',
        'updater.onStatus',
        'updater.onClearDismissal',
        'rateLimits.onUpdate',
        'rateLimits.get'
      ])
    ).toEqual([
      'updater.getStatus',
      'updater.onStatus',
      'updater.onClearDismissal',
      'rateLimits.onUpdate',
      'rateLimits.get'
    ])
    expect(
      groupOrder([
        'agentStatus.onSet',
        'agentStatus.onClear',
        'agentStatus.onMigrationUnsupported',
        'agentStatus.onMigrationUnsupportedClear',
        'agentStatus.onLegacyWorkerTerminalRecovery',
        'agentStatus.getSnapshot'
      ])
    ).toEqual([
      'agentStatus.onSet',
      'agentStatus.onClear',
      'agentStatus.onMigrationUnsupported',
      'agentStatus.onMigrationUnsupportedClear',
      'agentStatus.onLegacyWorkerTerminalRecovery',
      'agentStatus.getSnapshot'
    ])
    expect(
      groupOrder([
        'runtime.onTerminalFitOverrideChanged',
        'runtime.onTerminalDriverChanged',
        'runtime.onNativeChatLaunchDraftResolved',
        'runtime.onBrowserDriverChanged',
        'runtime.onBrowserRemoteViewersChanged',
        'runtime.onClientHostedBrowserRowsChanged',
        'runtime.getClientHostedBrowserRows',
        'runtime.getTerminalFitOverrides',
        'runtime.getTerminalDrivers',
        'runtime.getBrowserDrivers',
        'runtime.getBrowserRemoteViewerPages'
      ])
    ).toEqual([
      'runtime.onTerminalFitOverrideChanged',
      'runtime.onTerminalDriverChanged',
      'runtime.onNativeChatLaunchDraftResolved',
      'runtime.onBrowserDriverChanged',
      'runtime.onBrowserRemoteViewersChanged',
      'runtime.onClientHostedBrowserRowsChanged',
      'runtime.getClientHostedBrowserRows',
      'runtime.getTerminalFitOverrides',
      'runtime.getTerminalDrivers',
      'runtime.getBrowserDrivers',
      'runtime.getBrowserRemoteViewerPages'
    ])
    expect(
      [...listeners.values()].every((records) => records.filter((item) => item.active).length === 1)
    ).toBe(true)
    expect(storeSubscriptions.filter((item) => item.active)).toHaveLength(2)

    firstCleanup()
    const ipcCleanupOrder = cleanupOrder
      .filter((entry) => entry.startsWith('ipc.') && entry !== 'ipc.dispose')
      .map((entry) => entry.slice('ipc.'.length))
    expect(ipcCleanupOrder).toEqual(EXPECTED_CALLBACK_REGISTRATION_SEQUENCE)
    expect(cleanupOrder.slice(0, 6)).toEqual([
      'agent.disposeAsyncState',
      'mobile.disposeHydration',
      'store.unsubscribe.0',
      'runtimeStore.unsubscribe',
      'store.unsubscribe.1',
      'agentStore.unsubscribe'
    ])
    expect(cleanupOrder.indexOf('runtimeEnvironment.unsubscribe')).toBeGreaterThan(
      cleanupOrder.indexOf('ipc.ui.onMobileMarkdownRequest')
    )
    expect(cleanupOrder.indexOf('runtimeEnvironment.unsubscribe')).toBeLessThan(
      cleanupOrder.indexOf('ipc.repos.onChanged')
    )
    expect(cleanupOrder.indexOf('directSsh.stop')).toBeGreaterThan(
      cleanupOrder.lastIndexOf('ipc.runtime.onBrowserDriverChanged')
    )
    expect(cleanupOrder.at(-1)).toBe('notifications.reset')
    expect([...listeners.values()].every((records) => records.every((item) => !item.active))).toBe(
      true
    )
    expect(storeSubscriptions.filter((item) => item.active)).toHaveLength(0)
    expect(
      [...listeners.values()].every((records) =>
        records.every((item) => item.cleanup.mock.calls.length === 1)
      )
    ).toBe(true)

    const statusWritesBeforePostUnmountEvent = setUpdateStatus.mock.calls.length
    for (const record of listeners.get('updater.onStatus') ?? []) {
      if (record.active) {
        record.callback({ state: 'available' })
      }
    }
    expect(setUpdateStatus).toHaveBeenCalledTimes(statusWritesBeforePostUnmountEvent)

    const secondCleanup = installAppLifetimeIpcEvents(recordCleanupPhase)
    expect(
      [...listeners.values()].every((records) => records.filter((item) => item.active).length === 1)
    ).toBe(true)
    expect(storeSubscriptions.filter((item) => item.active)).toHaveLength(2)

    secondCleanup()
    expect([...listeners.values()].every((records) => records.every((item) => !item.active))).toBe(
      true
    )
    expect(storeSubscriptions.filter((item) => item.active)).toHaveLength(0)
    expect(
      [...listeners.values()].every((records) =>
        records.every((item) => item.cleanup.mock.calls.length === 1)
      )
    ).toBe(true)
  })
})
