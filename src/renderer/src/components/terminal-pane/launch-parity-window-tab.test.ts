import type * as React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import { createManager, createPane } from './pty-connection-test-pane-fixtures'
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
import { WINDOW_LAUNCH_CASES } from '../../../../shared/launch-parity-window-cases.test-fixture'
import {
  LAUNCH_TAB_ID,
  LAUNCH_TOKEN,
  PANE_GRID,
  launchWorkspaceId,
  windowSpawnRequest,
  type WindowLaunchCase
} from '../../../../shared/launch-parity-window-request.test-fixture'

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
  lifecycle: await import('./terminal-pane-lifecycle-primitives')
}))

/** Runs the case's real producer against a real store; returns the tab it opened. */
async function openTab(c: WindowLaunchCase) {
  const modules = await load(c.client)
  await installTerminalTestGlobals()
  Object.assign(window.api.platform, { get: () => ({ platform: c.client, osRelease: '10' }) })
  const store = modules.createStore()
  holder.store = store
  store.setState(launchWorkspaceState(c.workspace, c.settings))
  const worktreeId = launchWorkspaceId(c.workspace)
  const producer = c.producer
  if (producer.kind === 'quick-command') {
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
  } else {
    // The sidebar's "continue from transcript" builds the startup, then opens the tab.
    const startup = modules.resume.buildAiVaultResumeStartupForWorktree({
      state: store.getState(),
      worktreeId,
      session: {
        agent: 'antigravity',
        sessionId: 'ide-id',
        codexHome: null,
        executionHostId: c.workspace.connectionId ? `ssh:${c.workspace.connectionId}` : 'local',
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: building the bag and terminalOptions read only these deps, ptyDeps.startup and startupCwd.
  const managerOptions = modules.paneOptions.createTerminalPaneManagerOptions({
    deps: {
      tabId: tab.id,
      worktreeId,
      settingsRef: { current: store.getState().settings },
      isVisibleRef: { current: true },
      effectiveMacOptionAsAltRef: { current: 'false' }
    },
    ptyDeps: { startup },
    startupCwd: cwd
  } as never)
  const { vtExtensions } = {
    ...modules.defaults.buildDefaultTerminalOptions(),
    ...managerOptions.terminalOptions?.(pane.id)
  }
  pane.terminal.options.vtExtensions = { kittyKeyboard: vtExtensions?.kittyKeyboard === true }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane fixtures model every member connectPanePty reads, as in pty-connection-startup-command-delivery.test.ts.
  modules.pane.connectPanePty(pane as never, createManager(1) as never, deps as never)
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

// Pins main's current launch behaviour as the convergence parity baseline (rows 2 and 6, window
// half): the real producer, store and pane build the pty:spawn request each case's table row names.
describe('window-tab producers: the pty:spawn request a real pane sends', () => {
  // Why: the first import transforms the whole pane graph; keep that out of the first case.
  beforeAll(async () => {
    await load('darwin')
    await load('linux')
    await load('win32')
  }, 240_000)

  afterEach(async () => {
    await restoreTerminalTestGlobals()
    vi.unstubAllGlobals()
  })

  it.each(WINDOW_LAUNCH_CASES)('row $row: $name', async (c) => {
    expect(await paneSpawnRequest(c)).toEqual(windowSpawnRequest(c))
  })
})
