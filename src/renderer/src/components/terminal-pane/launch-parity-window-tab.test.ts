import type * as React from 'react'
import { Terminal } from '@xterm/headless'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import { createManager, createPane, terminalWriteText } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import {
  launchWorkspaceState,
  perClientLoader,
  type LaunchStoreHolder
} from '@/lib/launch-parity-renderer.test-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import { WINDOW_LAUNCH_CASES } from '../../../../shared/launch-parity-window-cases.test-fixture'
import { PLUS_LAUNCH_CASES } from '../../../../shared/launch-parity-plus-cases.test-fixture'
import { WORKSPACE_START_LAUNCH_CASES } from '../../../../shared/launch-parity-workspace-start-cases.test-fixture'
import {
  loadWorkspaceStartModules,
  startWorkspaceAgent
} from '@/lib/launch-parity-workspace-start.test-fixture'
import {
  LAUNCH_TAB_ID,
  LAUNCH_TOKEN,
  PANE_GRID,
  launchWorkspaceId,
  windowSpawnRequest,
  type WindowLaunchCase
} from '../../../../shared/launch-parity-window-request.test-fixture'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
import { mainLayoutApplyTransport } from './pty-connection-test-main-pane-start-fixtures'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { createPaneManagerOptionsTestContext } from './terminal-pane-manager-options-test-context'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const holder = vi.hoisted((): LaunchStoreHolder => ({ store: null }))
vi.mock('@/store', async () =>
  (await import('@/lib/launch-parity-renderer.test-fixture')).launchStoreModuleMock(holder)
)
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})
vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle: () => false }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), message: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return { ...actual, useCallback: <T>(fn: T): T => fn }
})
// Row 8: what precedes the launch (setup policy and hooks trust) is decided, not asked.
vi.mock('@/lib/launch-work-item-direct-preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveDirectSetupDecision: async () => ({ kind: 'decided', decision: 'inherit' })
}))
vi.mock('@/lib/ensure-hooks-confirmed', () => ({ ensureHooksConfirmed: async () => 'run' }))
vi.mock('@/lib/windows-terminal-capabilities', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasCachedWindowsTerminalCapabilities: () => true,
  getCachedWindowsTerminalCapabilities: () => ({
    wslAvailable: true,
    wslDistros: ['Ubuntu'],
    pwshAvailable: false,
    gitBashAvailable: false
  })
}))

const load = perClientLoader(async () => ({
  launch: await import('@/lib/launch-agent-in-new-tab'),
  quick: await import('@/lib/run-quick-command-in-new-tab'),
  vault: await import('@/lib/launch-ai-vault-session'),
  resume: await import('@/lib/ai-vault-resume-command'),
  pane: await import('./pty-connection'),
  paneOptions: await import('./terminal-pane-manager-options'),
  defaults: await import('@/lib/pane-manager/pane-terminal-options'),
  lifecycle: await import('./terminal-pane-lifecycle-primitives'),
  close: await import('../terminal/terminal-tab-actions'),
  layoutBindings: await import('./use-terminal-pane-layout-bindings'),
  parked: await import('./terminal-parked-tab-watchers'),
  parkedRegistry: await import('./terminal-parked-watcher-registry'),
  dispatcher: await import('./pty-dispatcher'),
  exitBuffer: await import('./pty-pre-handler-buffer'),
  react: await import('react'),
  server: await import('react-dom/server'),
  workspaceStart: await loadWorkspaceStartModules()
}))

/** Runs the case's real producer against a real store; returns the tab it opened. */
async function openTab(c: WindowLaunchCase) {
  const modules = await load(c.client)
  await installTerminalTestGlobals()
  Object.assign(window.api.platform, { get: () => ({ platform: c.client, osRelease: '10' }) })
  const store = modules.createStore()
  holder.store = store
  store.setState(
    launchWorkspaceState(c.workspace, { ...getDefaultSettings('/home/alice'), ...c.settings })
  )
  const worktreeId = launchWorkspaceId(c.workspace)
  const producer = c.producer
  if (producer.kind === 'work-item' || producer.kind === 'folder-composer') {
    await startWorkspaceAgent(modules.workspaceStart, store, { ...c, producer })
  } else if (producer.kind === 'quick-command') {
    modules.quick.runQuickCommandInNewTab({
      command: { id: 'qc-1', label: 'Fix', action: 'agent-prompt', ...producer },
      worktreeId
    })
  } else if (producer.kind === 'continuation') {
    // What launchAgentSessionContinuation passes once the agent is detected.
    modules.launch.launchAgentInNewTab({
      requestId: `parity-${c.name}`,
      agent: producer.agent,
      worktreeId,
      prompt: producer.prompt,
      promptDelivery: 'draft',
      launchSource: 'terminal_context_menu',
      initialCwd: producer.initialCwd
    })
  } else if (producer.kind === 'plus') {
    // Hand-built copies of what the "+" menu and the new-agent shortcut pass.
    modules.launch.launchAgentInNewTab({
      requestId: `parity-${c.name}`,
      agent: producer.agent,
      worktreeId,
      groupId: store.getState().activeGroupIdByWorktree[worktreeId],
      launchSource: producer.via === 'menu' ? 'tab_bar_quick_launch' : 'shortcut'
    })
  } else {
    // The sidebar's "continue from transcript" builds the startup, then opens the tab.
    const startup = modules.resume.buildAiVaultResumeStartupForWorktree({
      state: store.getState(),
      worktreeId,
      session: {
        agent: 'antigravity',
        sessionId: 'ide-id',
        codexHome: null,
        executionHostId: 'local',
        filePath: producer.transcript,
        cwd: producer.cwd
      }
    })
    modules.vault.launchAiVaultSessionInNewTab({ agent: 'antigravity', worktreeId, ...startup })
  }
  const tab = store.getState().tabsByWorktree[worktreeId]?.at(-1)
  if (!tab) {
    throw new Error(`${c.name}: the producer opened no tab`)
  }
  return { modules, store, worktreeId, tab }
}

/** Mounts the tab's pane the way TerminalPane does and returns the pty:spawn request it sends. */
async function paneSpawnRequest(c: WindowLaunchCase): Promise<unknown> {
  const { modules, store, worktreeId, tab } = await openTab(c)
  const spawn = vi.fn(async (_request: Record<string, unknown>) => ({ id: 'pty-1' }))
  const noop = (): (() => void) => () => {}
  Object.assign(window.api.pty, {
    spawn,
    onData: noop,
    onReplay: noop,
    onExit: noop,
    onWriteUnavailable: noop,
    onSideEffect: noop,
    resize: vi.fn(),
    claimViewport: vi.fn()
  })
  // As TerminalPane mounts: a queued initial cwd, else the tab's startup cwd, else the workspace.
  const cwd = modules.lifecycle.resolveQueuedInitialCwd(
    undefined,
    () => store.getState().consumeTabInitialCwd(tab.id),
    tab.startupCwd ?? c.workspace.path
  ).startupCwd
  const startup = store.getState().pendingStartupByTabId[tab.id]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real store state includes every StoreState member the pane reads.
  const deps = buildPaneConnectionDeps(() => store.getState() as never, {
    tabId: tab.id,
    worktreeId,
    cwd,
    startup
  })
  const pane = createPane(1)
  // A measured grid no lane defaults to, so the request shows the pane's size reached it.
  Object.assign(pane.terminal, PANE_GRID)
  // The xterm keyboard options the real TerminalPane builds for this tab, over the defaults (pane-dom-creation.ts).
  const paneArgs = mockPanePtyArgs(pane, createManager(1), deps)
  const optionsContext = createPaneManagerOptionsTestContext(paneArgs[2], null, cwd)
  optionsContext.deps.settingsRef = { current: store.getState().settings }
  const managerOptions = modules.paneOptions.createTerminalPaneManagerOptions(optionsContext)
  const { vtExtensions } = {
    ...modules.defaults.buildDefaultTerminalOptions(),
    ...managerOptions.terminalOptions?.(pane.id)
  }
  pane.terminal.options.vtExtensions = { kittyKeyboard: vtExtensions?.kittyKeyboard === true }
  modules.pane.connectPanePty(...paneArgs)
  await flushAsyncTicks(20)
  const [request] = spawn.mock.calls[0] ?? []
  // Fixed ids so the table can name them; the color replies are this harness's theme.
  const { terminalColorQueryReplies: _theme, ...rest } = request ?? {}
  return JSON.parse(
    JSON.stringify(rest)
      .replaceAll(tab.id, LAUNCH_TAB_ID)
      .replaceAll(String(rest.launchToken), LAUNCH_TOKEN)
  )
}

// Use real launch producers, store and pane to pin the spawn-request parity baseline for later convergence.
describe('window-tab producers: the pty:spawn request a real pane sends', () => {
  // Why: the first import transforms the whole pane graph; keep that out of the first case.
  beforeAll(async () => {
    await load('darwin')
    await load('win32')
  }, 240_000)

  afterEach(async () => {
    await restoreTerminalTestGlobals()
    vi.unstubAllGlobals()
  })

  it('keeps a typed parked sole pane readable and unwritable through closing IPC and late reattach until explicit close', async () => {
    const modules = await load('linux')
    await installTerminalTestGlobals()
    Object.assign(window.api.platform, { get: () => ({ platform: 'linux', osRelease: '6' }) })
    const workspace = { kind: 'folder', path: '/home/alice/source' } as const
    const worktreeId = launchWorkspaceId(workspace)
    const store = modules.createStore()
    holder.store = store
    store.setState(launchWorkspaceState(workspace, { ...getDefaultSettings('/home/alice') }))
    const pane = createPane(1)
    const manager = createManager(1, 1)
    const ptyId = `${worktreeId}@@retained-source`
    const incarnationId = 'source-incarnation'
    const tab = store.getState().createTab(worktreeId, undefined, undefined, {
      initialPtyId: ptyId,
      initialLeafId: pane.leafId
    })
    const spawn = vi.fn<typeof window.api.pty.spawn>(async () => ({
      id: ptyId,
      incarnationId,
      isReattach: true
    }))
    const onData = vi.fn<typeof window.api.pty.onData>(() => () => {})
    const onExit = vi.fn<typeof window.api.pty.onExit>(() => () => {})
    const noop = (): (() => void) => () => {}
    Object.assign(window.api.pty, {
      spawn,
      onData,
      onExit,
      onReplay: noop,
      onWriteUnavailable: noop,
      onSideEffect: noop,
      resize: vi.fn(),
      claimViewport: vi.fn()
    })
    const output = 'stopped source remains readable'
    const sink = new Terminal({
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
      allowProposedApi: true
    })
    const painted = Promise.withResolvers<void>()
    const reset = vi.fn(() => sink.reset())
    let binding: ReturnType<typeof modules.pane.connectPanePty> | undefined
    try {
      if (!('_core' in sink)) {
        throw new Error('headless terminal must expose the real user-input signal')
      }
      Object.assign(pane.terminal, { _core: sink._core, buffer: sink.buffer, reset })
      pane.terminal.onData.mockImplementation((listener: (data: string) => void) =>
        sink.onData(listener)
      )
      pane.terminal.write.mockImplementation((data, callback) => {
        sink.write(data, () => {
          callback?.()
          if (terminalWriteText(data).includes(output)) {
            painted.resolve()
          }
        })
      })
      pane.terminal.clear.mockImplementation(() => sink.clear())
      const renderedText = (): string =>
        Array.from({ length: sink.buffer.active.length }, (_, row) =>
          sink.buffer.active.getLine(row)?.translateToString(true)
        ).join('\n')
      const automaticClose = vi.fn((exitedPtyId: string) =>
        modules.close.closeTerminalTab(tab.id, {
          reason: 'pty-exit',
          lifecyclePtyId: exitedPtyId
        })
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real store supplies every state member read by the existing pane fixture.
      const deps = buildPaneConnectionDeps(() => store.getState() as never, {
        tabId: tab.id,
        worktreeId,
        cwd: workspace.path,
        restoredLeafId: pane.leafId,
        restoredPtyIdByLeafId: { [pane.leafId]: ptyId },
        onPtyExitRef: { current: automaticClose },
        consumeSuppressedPtyExit: vi.fn(store.getState().consumeSuppressedPtyExit),
        clearTabPtyId: vi.fn(store.getState().clearTabPtyId),
        updateTabPtyId: vi.fn(store.getState().updateTabPtyId)
      })
      const args = mockPanePtyArgs(pane, manager, deps)
      const controller: Partial<
        Parameters<typeof modules.layoutBindings.useTerminalPaneLayoutBindings>[0]
      > = {
        tabId: tab.id,
        managerRef: { current: args[1] },
        paneTransportsRef: args[2].paneTransportsRef,
        containerRef: { current: null },
        expandedPaneIdRef: { current: null },
        expandedStyleSnapshotRef: { current: new Map() },
        pendingPaneSizeRefreshFrameIdsRef: { current: [] },
        persistLayoutSnapshot: vi.fn(),
        setExpandedPaneId: vi.fn(),
        setTabPaneExpanded: store.getState().setTabPaneExpanded,
        setTabLayout: store.getState().setTabLayout
      }
      let layoutBindings:
        | ReturnType<typeof modules.layoutBindings.useTerminalPaneLayoutBindings>
        | undefined
      function LayoutBindings(): null {
        layoutBindings = modules.layoutBindings.useTerminalPaneLayoutBindings(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the binding hook reads only the supplied layout and expand/collapse controller fields, as in pending-split-close-test-fixture.
          controller as Parameters<typeof modules.layoutBindings.useTerminalPaneLayoutBindings>[0]
        )
        return null
      }
      modules.server.renderToString(modules.react.createElement(LayoutBindings))
      if (!layoutBindings) {
        throw new Error('real pane layout bindings were not created')
      }
      Object.assign(args[2], {
        syncPanePtyLayoutBinding: layoutBindings.syncPanePtyLayoutBinding,
        clearExitedPanePtyLayoutBinding: vi.fn(layoutBindings.clearExitedPanePtyLayoutBinding)
      })
      binding = modules.pane.connectPanePty(...args)
      await flushAsyncTicks(20)
      const transport = args[2].paneTransportsRef.current.get(pane.id)
      const dispatchData = onData.mock.calls[0]?.[0]
      const dispatchExit = onExit.mock.calls[0]?.[0]
      if (!transport || !dispatchData || !dispatchExit) {
        throw new Error('real IPC pane connection did not register its consumers')
      }
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: ptyId }))
      expect(transport.isConnected()).toBe(true)
      expect(transport.getPtyId()).toBe(ptyId)
      expect(store.getState().tabsByWorktree[worktreeId]).toEqual([tab])
      expect(store.getState().unifiedTabsByWorktree[worktreeId]).toEqual([
        expect.objectContaining({ contentType: 'terminal', entityId: tab.id })
      ])
      expect(manager.getPanes()).toEqual([{ id: pane.id, leafId: pane.leafId }])
      sink.input('status\r', true)
      await flushAsyncTicks(20)
      expect(window.api.pty.write).toHaveBeenCalledWith(ptyId, 'status\r', 'driving')
      dispatchData({ id: ptyId, data: output })
      await painted.promise
      expect(renderedText()).toContain(output)
      const paneKey = `${tab.id}:${pane.leafId}`
      const liveAnchor: SleepingAgentSessionRecord = {
        paneKey,
        tabId: tab.id,
        worktreeId,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'retained-source-conversation' },
        prompt: '',
        state: 'done',
        origin: 'live',
        capturedAt: 1,
        updatedAt: 1
      }
      store.setState({
        localOnlyScrollbackByTabId: { [tab.id]: { [pane.leafId]: output } },
        sleepingAgentSessionsByPaneKey: { [paneKey]: liveAnchor }
      })
      const layoutApply = await mainLayoutApplyTransport()
      expect(layoutApply.sentOfType('startPane')).toHaveLength(0)
      const registerLaunch = vi.spyOn(store.getState(), 'registerAgentLaunchConfig')
      const beforeExit = store.getState()
      const layout = beforeExit.terminalLayoutsByTabId[tab.id]
      expect(layout.root).toEqual({ type: 'leaf', leafId: pane.leafId })
      expect(layout.ptyIdsByLeafId).toEqual({ [pane.leafId]: ptyId })
      const writes = vi.mocked(window.api.pty.write).mock.calls.length
      const clears = pane.terminal.clear.mock.calls.length
      const resets = reset.mock.calls.length
      const retireTab = vi.spyOn(store.getState(), 'closeTab')

      modules.parked.captureParkedTerminalPaneCandidates(tab.id, worktreeId, [
        {
          ptyId,
          paneId: pane.id,
          leafId: pane.leafId,
          drivesTabTitle: true,
          untouchedFreshSpawn: binding.isUntouchedFreshSpawnPty(ptyId)
        }
      ])
      transport.detach?.({ preserveExitObserver: false })
      binding.dispose()
      args[2].paneTransportsRef.current.clear()
      modules.parked.syncParkedTerminalTabWatchersForWorkspaces(
        new Map([[worktreeId, { tabs: [tab], parkedTabIds: new Set([tab.id]) }]])
      )
      expect(modules.dispatcher.ptyExitHandlers.has(ptyId)).toBe(false)
      expect(
        modules.parkedRegistry.parkedWatchersByTabId.get(tab.id)?.disposersByPtyId.has(ptyId)
      ).toBe(true)
      expect(store.getState().isPtyShutdownPending(ptyId)).toBe(false)
      expect(store.getState().suppressedPtyExitIds[ptyId]).toBeUndefined()
      dispatchExit({ id: ptyId, code: 0, incarnationId, preserveRendererBinding: 'closing' })
      expect(modules.exitBuffer.hasPreHandlerPtyExit(ptyId, incarnationId)).toBe(true)
      expect(modules.parkedRegistry.parkedWatchersByTabId.get(tab.id)?.disposersByPtyId.size).toBe(
        0
      )
      expect(store.getState().terminalLayoutsByTabId[tab.id]).toEqual(layout)
      expect(store.getState().ptyIdsByTabId[tab.id]).toEqual([ptyId])
      const afterMarkerGrace = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001)
      try {
        args[2].mountFollowsTerminalPark = true
        binding = modules.pane.connectPanePty(...args)
        await flushAsyncTicks(20)
      } finally {
        afterMarkerGrace.mockRestore()
      }
      const revealedTransport = args[2].paneTransportsRef.current.get(pane.id)
      if (!revealedTransport) {
        throw new Error('real reveal did not install its transport')
      }
      expect(revealedTransport).not.toBe(transport)
      expect(modules.exitBuffer.hasPreHandlerPtyExit(ptyId)).toBe(false)
      await flushAsyncTicks(20)
      await layoutApply.settle()
      await flushAsyncTicks(20)
      expect(layoutApply.sentOfType('startPane')).toHaveLength(0)
      expect(registerLaunch).not.toHaveBeenCalled()
      expect(deps.consumeSuppressedPtyExit).toHaveReturnedWith(false)
      expect(transport.isConnected()).toBe(false)
      expect(transport.getPtyId()).toBeNull()
      expect(revealedTransport.isConnected()).toBe(false)
      expect(revealedTransport.getPtyId()).toBeNull()
      expect(revealedTransport.sendInput('must not run\r', 'driving')).toBe(false)
      expect(window.api.pty.write).toHaveBeenCalledTimes(writes)
      expect(automaticClose).not.toHaveBeenCalled()
      expect(retireTab).not.toHaveBeenCalled()
      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(args[2].clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(store.getState().tabsByWorktree[worktreeId]).toEqual(
        beforeExit.tabsByWorktree[worktreeId]
      )
      expect(store.getState().unifiedTabsByWorktree[worktreeId]).toEqual(
        beforeExit.unifiedTabsByWorktree[worktreeId]
      )
      expect(store.getState().terminalLayoutsByTabId[tab.id]).toEqual(layout)
      expect(store.getState().ptyIdsByTabId[tab.id]).toEqual([ptyId])
      expect(store.getState().localOnlyScrollbackByTabId[tab.id]).toEqual({ [pane.leafId]: output })
      expect(pane.terminal.clear).toHaveBeenCalledTimes(clears)
      expect(reset).toHaveBeenCalledTimes(resets)
      expect(renderedText()).toContain(output)
      expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({ [paneKey]: liveAnchor })
      expect(args[2].paneTransportsRef.current.get(pane.id)).toBe(revealedTransport)
      expect(spawn).toHaveBeenCalledTimes(1)

      vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
        foregroundProcess: null,
        hasChildProcesses: false,
        childProcessEvidence: 'no-children'
      })
      await new Promise<void>((resolve) =>
        modules.close.closeTerminalTab(tab.id, { reason: 'user', onClosed: resolve })
      )
      expect(retireTab).toHaveBeenCalledExactlyOnceWith(
        tab.id,
        expect.objectContaining({ reason: 'user' })
      )
      expect(store.getState().tabsByWorktree[worktreeId] ?? []).toEqual([])
      expect(store.getState().unifiedTabsByWorktree[worktreeId] ?? []).toEqual([])
      expect(store.getState().terminalLayoutsByTabId[tab.id]).toBeUndefined()
      expect(store.getState().localOnlyScrollbackByTabId[tab.id]).toBeUndefined()
      expect(store.getState().ptyIdsByTabId[tab.id]).toBeUndefined()
      expect(transport.sendInput('still must not run\r', 'driving')).toBe(false)
      expect(revealedTransport.sendInput('still must not run\r', 'driving')).toBe(false)
      expect(window.api.pty.write).toHaveBeenCalledTimes(writes)
      expect(spawn).toHaveBeenCalledTimes(1)
    } finally {
      binding?.dispose()
      modules.parkedRegistry.disposeAllParkedTerminalWatchers()
      sink.dispose()
    }
  })

  it.each([...WINDOW_LAUNCH_CASES, ...PLUS_LAUNCH_CASES, ...WORKSPACE_START_LAUNCH_CASES])(
    'row $row: $name',
    async (c) => {
      expect(await paneSpawnRequest(c)).toEqual(windowSpawnRequest(c))
    }
  )
})
