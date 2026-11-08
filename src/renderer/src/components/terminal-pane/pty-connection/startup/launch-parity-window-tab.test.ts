import type * as React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { createManager, createPane } from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import {
  launchWorkspaceState,
  perClientLoader,
  type LaunchStoreHolder
} from '@/lib/launch-parity-renderer.test-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { WINDOW_LAUNCH_CASES } from '../../../../../../shared/launch-parity-window-cases.test-fixture'
import { PLUS_LAUNCH_CASES } from '../../../../../../shared/launch-parity-plus-cases.test-fixture'
import { WORKSPACE_START_LAUNCH_CASES } from '../../../../../../shared/launch-parity-workspace-start-cases.test-fixture'
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
} from '../../../../../../shared/launch-parity-window-request.test-fixture'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'
import { createPaneManagerOptionsTestContext } from '../../mounting/terminal-pane-manager-options-test-context'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const holder = vi.hoisted((): LaunchStoreHolder => ({ store: null }))
vi.mock('@/store/index', async () =>
  (await import('@/lib/launch-parity-renderer.test-fixture')).launchStoreModuleMock(holder)
)
vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } =
    await import('../test-fixtures/pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})
vi.mock('../../titles/cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle: () => false
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), message: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-session/accounts/codex/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return { ...actual, useCallback: <T>(fn: T): T => fn }
})
// Row 8: what precedes the launch (setup policy and hooks trust) is decided, not asked.
vi.mock('@/lib/workspace/creation/setup/workspace-setup-preparation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inspectRequiredWorkspaceSetup: async () => ({ kind: 'decided', decision: 'inherit' })
}))
vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: async () => 'run',
  ensureHooksApproved: async () => ({ decision: 'run' })
}))
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
  launch: await import('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'),
  quick: await import('@/lib/run-quick-command-in-new-tab'),
  vault: await import('@/lib/launch-ai-vault-session'),
  resume: await import('@/lib/agent-session/resume/history/ai-vault-resume-command'),
  pane: await import('../connect-pane-pty'),
  paneOptions: await import('../../mounting/terminal-pane-manager-options'),
  defaults: await import('@/lib/pane-manager/pane-terminal-options'),
  lifecycle: await import('../../mounting/queued-initial-cwd'),
  workspaceStart: await loadWorkspaceStartModules()
}))

/** Runs the case's real producer against a real store; returns the tab it opened. */
async function openTab(c: WindowLaunchCase) {
  const modules = await load(c.client)
  await installTerminalTestGlobals()
  Object.assign(window.api.platform, { get: () => ({ platform: c.client, osRelease: '10' }) })
  const store = modules.createStore(
    (await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')).isClaudeAgent
  )
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
  const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')

  bindPaneAgentTitleMocks(paneArgs[2], agentTitleMocks)

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

  it.each([...WINDOW_LAUNCH_CASES, ...PLUS_LAUNCH_CASES, ...WORKSPACE_START_LAUNCH_CASES])(
    'row $row: $name',
    async (c) => {
      expect(await paneSpawnRequest(c)).toEqual(windowSpawnRequest(c))
    }
  )
})
