import { PtyBindingPersistenceOperations } from '../../src/main/persistence/loading-store/pty-binding-persistence'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite, type PtyIpcSuiteFixtures } from '../../src/main/ipc/pty-ipc-test-harness'
import { TerminalKilledError } from '../../src/main/daemon/daemon-pty-lifecycle-errors'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { registerPtyHandlers, setLocalPtyProvider } from '../../src/main/ipc/pty'
import { TerminalIntentionalStops } from '../../src/main/runtime/terminal-intentional-stops'

vi.mock('electron', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.electronModuleMock())
)
vi.mock('fs', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.fsModuleMock())
)
vi.mock('node-pty', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock())
)
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../../src/main/ipc/pty-ipc-mock-registry')).childProcessModuleMock(
    await importOriginal()
  )
)
vi.mock('../../src/main/opencode/hook-service', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../src/main/mimo/hook-service', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../src/main/agent-hooks/server', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../src/main/pi/titlebar-extension-service', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../src/main/pwsh', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../src/main/wsl', async (importOriginal) =>
  (await import('../../src/main/ipc/pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../src/main/telemetry/client', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../src/main/telemetry/classify-error', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../src/main/cli/linux-terminal-orca-cli-shim', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../src/main/memory/pty-registry', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../src/main/agent-hooks/migration-unsupported-pty-state', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) =>
    m.migrationUnsupportedPtyModuleMock()
  )
)
vi.mock('../../src/main/codex/codex-pane-account-registry', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) =>
    m.codexPaneAccountRegistryModuleMock()
  )
)
vi.mock('../../src/main/codex/codex-state-db-backfill-recovery', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) =>
    m.codexBackfillRecoveryModuleMock()
  )
)

const worktreeId = 'wt-1'
const cwd = '/tmp/restart'
const tabId = 'tab-1'
const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = makePaneKey(tabId, leafId)

type RestartHarness = ReturnType<typeof installRestartHarness>

function registerWithFakes(
  mainWindow: PtyIpcSuiteFixtures['mainWindow'],
  runtime: RestartHarness['runtime'],
  store: RestartHarness['store']
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spawn and kill read only the window, runtime and store members these fakes define.
  const args = [
    mainWindow,
    runtime,
    undefined,
    undefined,
    undefined,
    store
  ] as unknown as Parameters<typeof registerPtyHandlers>
  registerPtyHandlers(...args)
}

function installRestartHarness(
  options: { shutdownFails?: boolean; shutdownGate?: Promise<void> } = {}
) {
  let oldSessionAlive = true
  const control = { shutdownFails: options.shutdownFails ?? false }
  const providerSpawn = vi.fn(async (spawnOptions: { attachOnly?: boolean }) => {
    if (!spawnOptions.attachOnly) {
      return { id: 'pty-new', incarnationId: 'inc-new' }
    }
    if (!oldSessionAlive) {
      throw new TerminalKilledError('pty-old')
    }
    return { id: 'pty-old', incarnationId: 'inc-old', isReattach: true }
  })
  const shutdown = vi.fn(async () => {
    await options.shutdownGate
    if (control.shutdownFails) {
      throw new Error('daemon unreachable')
    }
    oldSessionAlive = false
  })
  const provider = {
    spawn: providerSpawn,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    shutdown,
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listProcesses: vi.fn(async () => []),
    attach: vi.fn(),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart path calls only the provider members this fake defines.
  setLocalPtyProvider(provider as unknown as Parameters<typeof setLocalPtyProvider>[0])
  let session = {
    tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-old' }] },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf' as const, leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: 'pty-old' }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-old' }
  }
  const store = {
    isRuntimeWorkspaceSessionRetired: vi.fn(() => false),
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn((next) => {
      session = next
    }),
    flushOrThrow: vi.fn(),
    runDurableMutation: vi.fn(async <T>(mutate: () => { value: T }) => mutate().value),
    getWorkspaceSessionHostIds: vi.fn(() => ['local']),
    getFolderWorkspace: vi.fn(() => undefined),
    getFolderWorkspaces: vi.fn(() => []),
    getProjectGroups: vi.fn(() => []),
    getRepos: vi.fn(() => [])
  }
  const state = { workspaceSession: session, workspaceSessionsByHostId: {} }
  store.getWorkspaceSession.mockImplementation((hostId?: string) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each fake partition has the same session shape.
    const partitions = state.workspaceSessionsByHostId as Record<string, typeof session>
    return (hostId && partitions[hostId]) || state.workspaceSession
  })
  const bindingRuntime = {
    state,
    dirtyProfileStateDomains: new Set(),
    runDurableMutation: store.runDurableMutation,
    writeTimer: null,
    pendingWrite: null,
    quitFlushStarted: false,
    writeGeneration: 0,
    lastDurableWriteGeneration: 0
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: binding writes read only state, write bookkeeping, durable mutation and the session partitions from these fakes.
  const bindingArgs = [bindingRuntime, store] as unknown as ConstructorParameters<
    typeof PtyBindingPersistenceOperations
  >
  const bindingOperations = new PtyBindingPersistenceOperations(...bindingArgs)
  const storeWithRetirement = Object.assign(store, {
    persistPtyBinding: bindingOperations.persistPtyBinding.bind(bindingOperations),
    retirePtyBinding: bindingOperations.retirePtyBinding.bind(bindingOperations)
  })
  const runtime = {
    setPtyController: vi.fn(),
    resolveTerminalPane: vi.fn(() => {
      throw new Error('terminal_not_found')
    }),
    markPtyStopRequested: vi.fn(),
    createPreAllocatedTerminalHandle: vi.fn(() => 'term-restart'),
    preAllocateHandleForPty: vi.fn(() => 'term-restart'),
    registerPreAllocatedHandleForPty: vi.fn(),
    beginPtyRegistration: vi.fn(),
    cancelPendingPtyRegistration: vi.fn(),
    assertPtyRegistrationAllowed: vi.fn(),
    registerPty: vi.fn(),
    noteTerminalSpawnCommand: vi.fn(),
    seedHeadlessTerminal: vi.fn(),
    onPtySpawned: vi.fn(),
    onPtyExit: vi.fn(),
    onPtyData: vi.fn(),
    intentionalPtyStops: new TerminalIntentionalStops()
  }
  return { providerSpawn, shutdown, store: storeWithRetirement, runtime, control }
}

import {
  createPane,
  createManager
} from '../../src/renderer/src/components/terminal-pane/pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-deps'
import { createInitialStoreState } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../../src/renderer/src/components/terminal-pane/pty-connection-test-environment'
import { installIpcPtyWindow } from '../../src/renderer/src/components/terminal-pane/pty-transport-test-harness'
import type { StoreState } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-store-state'
import type * as React from 'react'
import type { PtyTransport } from '../../src/renderer/src/components/terminal-pane/pty-transport-types'

let rendererState: StoreState
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => rendererState,
    subscribe: () => () => {}
  }
}))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void) => effect(),
  useLayoutEffect: (effect: () => void) => effect()
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
const { requestTerminalPaneRecovery } = vi.hoisted(() => ({
  requestTerminalPaneRecovery: vi.fn(async () => true)
}))
vi.mock(
  '../../src/renderer/src/components/terminal-pane/terminal-pane-recovery',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    requestTerminalPaneRecovery
  })
)

describe('account restart through renderer connection and host spawn', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('replaces a tombstoned owner while its persisted pane binding has not yet been cleared', async () => {
    const host = installRestartHarness()
    registerWithFakes(mainWindow, host.runtime, host.store)
    rendererState = createInitialStoreState(() => rendererState)
    rendererState.tabsByWorktree[worktreeId][0].ptyId = 'pty-old'
    rendererState.ptyIdsByTabId[tabId] = ['pty-old']
    rendererState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId,
      worktreeId,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'another-agents-session' },
      state: 'waiting',
      prompt: '',
      capturedAt: 1,
      updatedAt: 1
    }
    rendererState.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId] = 'pty-old'
    await installTerminalTestGlobals()
    installIpcPtyWindow(window, {})
    window.api.pty.claimViewport = vi.fn()
    const spawnErrors: unknown[] = []
    vi.mocked(window.api.pty.spawn).mockImplementation(async (args) => {
      try {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registered pty:spawn returns the preload's spawn response.
        return (await handlers.get('pty:spawn')!(null, args)) as Awaited<
          ReturnType<typeof window.api.pty.spawn>
        >
      } catch (error) {
        spawnErrors.push(error)
        throw error
      }
    })
    const { createIpcPtyTransport } =
      await import('../../src/renderer/src/components/terminal-pane/pty-transport')
    const { useTerminalPaneProcessExitActions } =
      await import('../../src/renderer/src/components/terminal-pane/use-terminal-pane-process-exit-actions')
    const oldTransport = createIpcPtyTransport({ worktreeId, tabId, leafId })
    oldTransport.attach({ existingPtyId: 'pty-old', callbacks: {} })
    const pane = createPane(1)
    const manager = createManager(1)
    manager.getPanes.mockReturnValue([pane])
    const transports = new Map<number, PtyTransport>([[1, oldTransport]])
    const bindings = new Map<number, { dispose: () => void }>()
    const deps = buildPaneConnectionDeps(() => rendererState, {
      tabId,
      worktreeId,
      cwd,
      paneTransportsRef: { current: transports },
      clearTabPtyId: vi.fn(() => {
        rendererState.tabsByWorktree[worktreeId][0].ptyId = null
        rendererState.ptyIdsByTabId[tabId] = []
      })
    })
    const controller = {
      ...deps,
      managerRef: { current: manager },
      panePtyBindingsRef: { current: bindings },
      savedLayout: { ptyIdsByLeafId: { [leafId]: 'pty-old' } },
      pendingCodexPaneRestartIds: { 'pty-old': true },
      consumePendingCodexPaneRestart: vi.fn(() => true),
      clearCodexRestartNotice: vi.fn(),
      suppressPtyExit: vi.fn(),
      setTerminalError: vi.fn(),
      setTerminalErrorsByPaneId: vi.fn(),
      setPaneProcessExitsByPaneId: vi.fn(),
      executeClosePane: vi.fn(),
      handlePaneProcessDied: vi.fn(),
      showRestoredSessionBanner: vi.fn(),
      onPtyErrorClearedRef: { current: vi.fn() },
      onPtyRecoveryStateRef: { current: vi.fn() }
    }
    useTerminalPaneProcessExitActions(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: existing connection fixture supplies restart callbacks; DOM/terminal rendering is simulated.
      controller as unknown as Parameters<typeof useTerminalPaneProcessExitActions>[0]
    )
    try {
      await vi.waitFor(() => expect(window.api.pty.spawn).toHaveBeenCalled())
      await vi.waitFor(() =>
        expect(
          host.shutdown,
          JSON.stringify(vi.mocked(window.api.pty.spawn).mock.calls)
        ).toHaveBeenCalled()
      )
      await vi.waitFor(() =>
        expect(transports.get(1)?.getPtyId(), String(spawnErrors[0])).toBe('pty-new')
      )
      expect(window.api.pty.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          replacesPtyId: 'pty-old',
          command: 'codex',
          launchAgent: 'codex',
          startupCommandDelivery: 'shell-ready'
        })
      )
      expect(vi.mocked(window.api.pty.spawn).mock.calls[0][0]).not.toHaveProperty(
        'resumeProviderSession'
      )
      expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
      // The replacement's own bind swapped the host's persisted pane binding.
      expect(
        host.store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
      ).toBe('pty-new')
    } finally {
      for (const binding of bindings.values()) {
        binding.dispose()
      }
      for (const transport of transports.values()) {
        transport.detach?.({ preserveExitObserver: false })
      }
    }
  })
  it.each([false, true])(
    'paired restart retains the old owner (host authority: %s)',
    async (hostAuthority) => {
      const host = installRestartHarness()
      registerWithFakes(mainWindow, host.runtime, host.store)
      rendererState = createInitialStoreState(() => rendererState)
      await installTerminalTestGlobals()
      const runtimeCall = vi.fn(
        async (args: { method: string; params?: Record<string, unknown> }) => {
          if (args.method === 'status.get') {
            return {
              id: 'status',
              ok: true,
              result: {
                runtimeProtocolVersion: 3,
                minCompatibleRuntimeClientVersion: 2,
                capabilities: hostAuthority ? ['agent-session.host-authority.v1'] : []
              },
              _meta: { runtimeId: 'fake-host' }
            }
          }
          if (args.method !== 'terminal.create' && args.method !== 'terminal.createAgentSession') {
            throw new Error(`Unexpected host method: ${args.method}`)
          }
          // Both host create routes ultimately use stable-pane adoption; keep that real here.
          await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            cwd,
            tabId,
            leafId,
            worktreeId,
            command: 'codex',
            launchAgent: 'codex',
            startupCommandDelivery: 'shell-ready'
          })
          return {
            id: 'create',
            ok: true,
            result: {
              terminal: { handle: 'term-old', worktreeId, title: null, surface: 'background' }
            },
            _meta: { runtimeId: 'fake-host' }
          }
        }
      )
      const subscribe = vi.fn(
        async (_args: unknown, callbacks: { onResponse: (value: unknown) => void }) => {
          queueMicrotask(() =>
            callbacks.onResponse({
              id: 'stream',
              ok: true,
              result: { type: 'ready' },
              _meta: { runtimeId: 'fake-host' }
            })
          )
          return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
        }
      )
      Object.assign(window.api, { runtimeEnvironments: { call: runtimeCall, subscribe } })
      const { createRemoteRuntimePtyTransport } =
        await import('../../src/renderer/src/components/terminal-pane/remote-runtime-pty-transport')
      const { releasePaneTransportForRestart } =
        await import('../../src/renderer/src/components/terminal-pane/pane-restart-transport-handoff')
      const { CODEX_ACCOUNT_RESTART_STARTUP } =
        await import('../../src/renderer/src/lib/codex-session-restart')
      const options = { worktreeId, tabId, leafId, ...CODEX_ACCOUNT_RESTART_STARTUP }
      const old = createRemoteRuntimePtyTransport('fake-host', options)
      await old.connect({ url: '', callbacks: {} })
      expect(old.getPtyId()).toBe('remote:fake-host@@term-old')
      const replacesPtyId = releasePaneTransportForRestart(old)
      expect(replacesPtyId).toBeNull()
      const replacement = createRemoteRuntimePtyTransport('fake-host', options)
      try {
        await replacement.connect({ url: '', callbacks: {} })
        expect(replacement.getPtyId()).toBe('remote:fake-host@@term-old')
        expect(host.shutdown).not.toHaveBeenCalled()
        expect(host.providerSpawn.mock.calls.every(([options]) => options.attachOnly)).toBe(true)
        expect(
          runtimeCall.mock.calls.filter(([args]) => args.method.startsWith('terminal.create'))
        ).toHaveLength(2)
      } finally {
        replacement.detach?.()
      }
    }
  )
})
