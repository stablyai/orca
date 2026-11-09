import { ptyIncarnationById, ptyOwnership } from '../../src/main/ipc/pty/provider/ownership-state'
import { createLaunchRaceRuntime } from '../../src/main/ipc/pty/pty-launch-race-test-fixture'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AgentPaneLaunchRequest } from '../../src/shared/agent-launch/contracts/agent-pane-launch-request'
import { setupPtyIpcSuite } from '../../src/main/ipc/pty/pty-ipc-test-harness'
import { classifyErrorMock, statSyncMock } from '../../src/main/ipc/pty/pty-ipc-mock-registry'
import { registerPtyHandlers } from '../../src/main/ipc/pty/register-handlers'
import {
  isAgentLaunchRunningIn,
  markAgentLaunchesClosedByUser,
  resetAgentLaunchPanesForTests
} from '../../src/main/agent-launch/agent-launch-pane-attachment'
import '../../src/shared/agent-launch/contracts/agent-launch-pane-verdict'
import { makePaneKey } from '../../src/shared/workspace-layout/stable-pane-id'
import {
  makePaneSpawnReservationKey,
  paneSpawnReservationsByOwnerKey
} from '../../src/main/ipc/pty/pane/spawn-reservation'
import { acquireWatcherRemovalGate } from '../../src/main/workspaces/removal/watcher-removal-gate'
import { planQueuedPaneAgentLaunch } from '../../src/main/ipc/pty/pane-agent-launch.test-fixture'
import { tokenizeStartupCommand } from '../../src/shared/agent-launch/startup/tui-agent-startup-shell'
import type * as LaunchAgentKindModule from '../../src/shared/agent-kind'

const renderer = vi.hoisted(() => {
  const ptyIdsByTabId: Record<string, string[]> = {}
  return {
    state: {
      settings: {},
      activeWorktreeId: 'repo-1::/tmp/pane-launch',
      tabsByWorktree: {},
      ptyIdsByTabId,
      seedNativeChatLaunchPrompt: vi.fn(),
      seedNativeChatLaunchDraft: vi.fn(),
      markNativeChatLaunchPromptFailed: vi.fn()
    },
    subscribers: new Set<(state: { ptyIdsByTabId: Record<string, string[]> }) => void>(),
    watchers: new Map<string, (data: string) => void>(),
    writes: vi.fn(async (_ptyId: string, _data: string) => true)
  }
})
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => renderer.state,
    subscribe: (listener: (state: { ptyIdsByTabId: Record<string, string[]> }) => void) => {
      renderer.subscribers.add(listener)
      return () => renderer.subscribers.delete(listener)
    }
  }
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({
  ensurePtyDispatcher: () => {}
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: (id: string, listener: (data: string) => void) => {
    renderer.watchers.set(id, listener)
    return () => renderer.watchers.delete(id)
  }
}))
vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: async () => null
}))
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: renderer.writes
}))
vi.mock('@/runtime/hosted-terminals/streams/runtime-terminal-data-subscription', () => ({
  subscribeToRuntimeTerminalData: vi.fn()
}))
vi.mock('@/lib/agent-session/messaging/paste/agent-ready-wait', () => ({
  waitForAgentReady: async () => ({ ready: false })
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: mockLaunchAgentKind }))
const mockLaunchAgentKind = vi.hoisted(() => () => 'claude')
vi.mock('../../src/shared/agent-kind', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchAgentKindModule>()),
  tuiAgentToAgentKind: mockLaunchAgentKind
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

vi.mock('electron', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.electronModuleMock())
)
vi.mock('fs', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.fsModuleMock())
)
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../../src/main/ipc/pty/pty-ipc-mock-registry')).fsPromisesModuleMock(
    await importOriginal()
  )
)
vi.mock('node-pty', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock())
)
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../../src/main/ipc/pty/pty-ipc-mock-registry')).childProcessModuleMock(
    await importOriginal()
  )
)
vi.mock('../../src/main/opencode/hook-service', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.openCodeHookServiceModuleMock()
  )
)
vi.mock('../../src/main/mimo/hook-service', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../src/main/agent-hooks/server/agent-hook-server', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../src/main/pi/titlebar-extension-service', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.piTitlebarExtensionModuleMock()
  )
)
vi.mock('../../src/main/pty/shell-startup/pwsh', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../src/main/wsl/filesystem/unc-path-access', async (importOriginal) =>
  (await import('../../src/main/ipc/pty/pty-ipc-mock-registry')).wslModuleMock(
    await importOriginal()
  )
)
vi.mock('../../src/main/telemetry/client', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../src/main/telemetry/classify-error', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../src/main/cli/linux-terminal-orca-cli-shim', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../src/main/memory/pty-registry', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../src/main/agent-hooks/observations/migration-unsupported-pty-state', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.migrationUnsupportedPtyModuleMock()
  )
)
vi.mock('../../src/main/codex/configuration/homes/codex-pane-account-registry', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.codexPaneAccountRegistryModuleMock()
  )
)
vi.mock('../../src/main/codex/history/index/codex-state-db-backfill-recovery', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.codexBackfillRecoveryModuleMock()
  )
)

// An AI button's launch is planned inside its pane's spawn, with the host's planner, and writes no
// launch record.
describe('a pane that starts its own agent launch', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()
  const tabId = 'tab-pane-launch'
  const leafId = '66666666-6666-4666-8666-666666666666'
  const worktreeId = 'repo-1::/tmp/pane-launch'
  const PANE_ADDRESS = { worktreeId, tabId, leafId }
  const AI_BUTTON: AgentPaneLaunchRequest = {
    launch: { agent: 'claude', target: { kind: 'existing', worktree: `id:${worktreeId}` } }
  }

  afterEach(() => {
    resetAgentLaunchPanesForTests()
    ptyIncarnationById.delete('pty-agent')
    ptyOwnership.delete('pty-agent')
  })

  function register(
    providerSpawn: ReturnType<typeof vi.fn>,
    plan: () => Promise<Record<string, unknown>> = async () => ({ command: 'claude' })
  ) {
    classifyErrorMock.mockReturnValue({ error_class: 'unknown' })
    installDaemonTestProvider({ spawn: providerSpawn, hasPty: (id: string) => id === 'pty-agent' })
    const runtime = {
      ...createLaunchRaceRuntime(),
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_pane'),
      registerPreAllocatedHandleForPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(),
      hasLiveTerminalForPaneKey: vi.fn(() => false),
      reportAgentLaunchPaneVerdict: vi.fn(),
      showTerminalWorkspaceLaunchScope: vi.fn(async () => ({
        id: worktreeId,
        path: '/tmp/pane-launch',
        connectionId: null,
        repo: null,
        folderWorkspace: null
      })),
      planAgentPaneLaunch: vi.fn(plan),
      getTerminalHandleForPaneKey: vi.fn(() => null),
      closeTerminal: vi.fn(async () => ({}))
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite's window double, carrying the members a renderer spawn reaches.
    const window = mainWindow as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a runtime carrying only the members a pane's own launch reaches.
    const spawnRuntime = runtime as never
    registerPtyHandlers(window, spawnRuntime)
    return runtime
  }

  function spawnPane(
    agentLaunch: AgentPaneLaunchRequest = AI_BUTTON,
    pane: Record<string, unknown> = {}
  ): Promise<unknown> {
    return Promise.resolve(
      handlers.get('pty:spawn')!(null, {
        cols: 132,
        rows: 40,
        cwd: '/tmp/pane-launch',
        worktreeId,
        tabId,
        leafId,
        command: '',
        agentLaunch,
        ...pane
      })
    )
  }

  it('compiles an Automation submit on the host with its full options, raw Args and separate extras', async () => {
    const prompt = `Review 'the changes'\n${'Keep every requested detail. '.repeat(1200)}`.trim()
    const planned = await planQueuedPaneAgentLaunch(
      {
        launch: {
          ...AI_BUTTON.launch,
          prompt: { text: prompt, delivery: 'submit' },
          agentArgs: `  --add-dir '/authored path' --model raw-model --effort low  `,
          sessionOptions: {
            model: 'private/sonnet',
            effort: 'high',
            fastMode: 'true',
            permissionMode: 'accept-edits'
          }
        },
        extraAgentArgs: `--add-dir '/extra path' --model extra-model --effort medium`,
        startupPromptCarry: 'force-line',
        suppressStartupUpdatePrompt: true,
        returnLaunchFailure: true
      },
      {
        agentCmdOverrides: { claude: 'claude-host' },
        agentDefaultArgs: { claude: '--add-dir /host-default' },
        agentDefaultEnv: { claude: { PANE_HOST_SENTINEL: 'host' } },
        agentPermissionDefault: 'own'
      },
      PANE_ADDRESS
    )

    const parsed = tokenizeStartupCommand(planned.command ?? '', 'posix')
    expect(parsed.ok && parsed.tokens).toEqual([
      'claude-host',
      '--add-dir',
      '/authored path',
      '--add-dir',
      '/extra path',
      '--model',
      'private/sonnet',
      '--effort',
      'high',
      '--settings',
      '{"fastMode":true}',
      '--permission-mode',
      'acceptEdits',
      prompt
    ])
    expect(planned).toMatchObject({
      launchAgent: 'claude',
      env: { PANE_HOST_SENTINEL: 'host', ORCA_AGENT_LAUNCH_TOKEN: expect.any(String) },
      launchConfig: { agentEnv: { PANE_HOST_SENTINEL: 'host' } }
    })
    expect(planned.launchConfig?.agentCommand).not.toContain(prompt)
    expect(planned.launchConfig?.agentArgs).not.toContain('/host-default')
    expect(planned.agentLaunch).toBeUndefined()
  })

  // Planned command quoting requires the planner's runtime shell; an inferred tab shell can reject WSL-share repos.
  it("runs the plan's runtime shell, not the tab's, as a host launch does", async () => {
    const providerSpawn = vi.fn(async (_options: { shellOverride?: string }) => ({
      id: 'pty-agent'
    }))
    const runtime = register(providerSpawn, async () => ({
      command: 'claude',
      launchRuntime: {
        platform: process.platform,
        pty: { shellOverride: '/bin/planned-shell', terminalWindowsWslDistro: null }
      }
    }))

    await spawnPane(AI_BUTTON, { shellOverride: 'cmd.exe' })

    expect(runtime.planAgentPaneLaunch).toHaveBeenCalledWith(
      worktreeId,
      expect.not.objectContaining({ shellOverride: expect.anything() }),
      undefined
    )
    expect(providerSpawn.mock.calls[0]?.[0].shellOverride).toBe('/bin/planned-shell')
  })

  // Orchestration callers, hook evidence and title presence read the launch's token off its PTY.
  it("gives the agent its launch token and agent identity, as the host's own launch did", async () => {
    const providerSpawn = vi.fn(async (_options: { env?: Record<string, string> }) => ({
      id: 'pty-agent',
      incarnationId: 'inc-1'
    }))
    const runtime = register(providerSpawn, async () => ({
      command: 'claude',
      launchAgent: 'claude',
      launchConfig: { agentArgs: '', agentEnv: {} }
    }))

    await spawnPane()

    const env = providerSpawn.mock.calls[0]?.[0]?.env ?? {}
    expect(env.ORCA_AGENT_LAUNCH_TOKEN).toMatch(/.+/)
    expect(JSON.stringify(runtime.registerPty.mock.calls)).toContain(
      JSON.stringify({
        launchToken: env.ORCA_AGENT_LAUNCH_TOKEN,
        launchAgent: 'claude',
        launchConfig: { agentArgs: '', agentEnv: {} }
      })
    )
  })

  it('starts an agent in the workspace root when its folder is gone, and says so', async () => {
    const missing = '/tmp/pane-launch/deleted'
    statSyncMock.mockImplementation((target: string) => {
      if (target === missing) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, mode: 0o755 }
    })
    const providerSpawn = vi.fn(async (_options: { cwd?: string }) => ({
      id: 'pty-agent',
      startupCwdSource: 'request' as const
    }))
    register(providerSpawn)

    const result = await spawnPane(AI_BUTTON, { cwd: missing })

    expect(providerSpawn.mock.calls[0]?.[0].cwd).toBe('/tmp/pane-launch')
    expect(result).toMatchObject({
      startupCwdFallback: { kind: 'worktree', cwd: '/tmp/pane-launch' }
    })
  })

  it('starts one agent when the pane spawns twice at once', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-agent' }))
    register(providerSpawn)

    await Promise.all([spawnPane(), spawnPane()])

    expect(providerSpawn).toHaveBeenCalledOnce()
  })

  it('starts nothing when the user closed the pane while it was planned', async () => {
    let releasePlan!: () => void
    const providerSpawn = vi.fn(async () => ({ id: 'pty-agent' }))
    const runtime = register(
      providerSpawn,
      () =>
        new Promise((done) => {
          releasePlan = () => done({ command: 'claude' })
        })
    )

    const spawned = spawnPane()
    await vi.waitFor(() => expect(runtime.planAgentPaneLaunch).toHaveBeenCalled())
    markAgentLaunchesClosedByUser(worktreeId, { kind: 'pane', tabId, leafId })
    releasePlan()

    await expect(spawned).rejects.toThrow('agent_launch_tab_closed')
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalled()
  })

  it('starts nothing and releases its preparation when the pane closes while its lease waits', async () => {
    let resolveLease!: (release: () => void) => void
    const lease = new Promise<() => void>((resolve) => {
      resolveLease = resolve
    })
    const releaseLease = vi.fn()
    const acquireWorktreeTerminalSpawn = vi.fn(() => lease)
    const providerSpawn = vi.fn(async () => ({ id: 'pty-agent' }))
    const runtime = register(providerSpawn)
    Object.assign(runtime, { acquireWorktreeTerminalSpawn })

    const spawned = spawnPane().catch((error: unknown) => error)
    await vi.waitFor(() => expect(acquireWorktreeTerminalSpawn).toHaveBeenCalledOnce())
    const key = makePaneSpawnReservationKey(worktreeId, null, makePaneKey(tabId, leafId))!
    const reservation = paneSpawnReservationsByOwnerKey.get(key)!
    expect(reservation).toBeDefined()
    const closedPane = { kind: 'pane', tabId, leafId } as const
    expect(isAgentLaunchRunningIn(worktreeId, closedPane)).toBe(true)
    const removal = acquireWatcherRemovalGate('/tmp/pane-launch')
    onTestFinished(() => removal.release())
    const drained = vi.fn()
    const preparationDone = removal.ready.then(drained)
    await Promise.resolve()
    expect(drained).not.toHaveBeenCalled()

    markAgentLaunchesClosedByUser(worktreeId, closedPane)
    resolveLease(releaseLease)

    expect(await spawned).toMatchObject({ message: 'agent_launch_tab_closed' })
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(releaseLease).toHaveBeenCalledOnce()
    await expect(reservation.promise).rejects.toThrow('agent_launch_tab_closed')
    expect(paneSpawnReservationsByOwnerKey.has(key)).toBe(false)
    expect(isAgentLaunchRunningIn(worktreeId, closedPane)).toBe(false)
    await preparationDone
    expect(drained).toHaveBeenCalledOnce()
    expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalled()
  })

  it.each([
    'accepted',
    'planner-failed',
    'unconfirmed',
    'registration-exited',
    'closed-late',
    'remount'
  ] as const)(
    'settles %s from actual main spawn through renderer connect and owned prompt delivery',
    async (scenario) => {
      const { connectIpcPty } =
        await import('@/components/terminal-pane/pty-transport/ipc/ipc-pty-connect')
      const { awaitAgentLaunchPaneStart } =
        await import('@/lib/agent-session/launch/pane/agent-launch-pane-start')
      const { noteAgentLaunchPaneClosedByUser } =
        await import('@/lib/agent-session/launch/pane/agent-launch-pane-closes')
      const { pasteAgentLaunchPromptOnceReady } =
        await import('@/lib/agent-session/launch/prompt/launch-agent-tab-prompt-paste')
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const providerSpawn = vi.fn(async (): Promise<{ id: string; isReattach?: boolean }> => {
        if (scenario === 'closed-late') {
          await pending
        }
        if (scenario === 'unconfirmed') {
          throw new Error('provider answer lost')
        }
        return { id: 'pty-agent' }
      })
      const runtime = register(providerSpawn, async () => {
        if (scenario === 'planner-failed') {
          throw new Error('agent_launch_agent_disabled')
        }
        return { command: 'claude' }
      })
      if (scenario === 'registration-exited') {
        runtime.registerPty.mockImplementation(() => {
          throw new Error('agent_session_exited_during_start')
        })
        Object.assign(runtime, { getPtyLivenessVerdict: () => ({ status: 'exited' }) })
      }
      runtime.hasLiveTerminalForPaneKey.mockImplementation(
        () => runtime.registerPty.mock.calls.length > 0
      )
      // The verdict push is deliberately not delivered: response settlement must be sufficient.
      renderer.state.ptyIdsByTabId = {}
      renderer.subscribers.clear()
      renderer.watchers.clear()
      renderer.writes.mockClear()
      renderer.state.seedNativeChatLaunchPrompt.mockClear()
      renderer.state.seedNativeChatLaunchDraft.mockClear()
      const started = awaitAgentLaunchPaneStart(tabId, leafId)
      const delivered = vi.fn()
      const delivery = pasteAgentLaunchPromptOnceReady({
        worktreeId,
        tabId,
        agent: 'claude',
        prompt: 'fix checks',
        content: 'fix checks',
        submit: true,
        launchPty: started,
        onPromptDelivered: delivered
      })
      vi.stubGlobal('window', {
        setTimeout,
        clearTimeout,
        api: {
          pty: { spawn: (args: unknown) => handlers.get('pty:spawn')!(null, args), kill: vi.fn() }
        }
      })
      onTestFinished(() => {
        vi.unstubAllGlobals()
      })
      const transportOptions = {
        cwd: '/tmp/pane-launch',
        worktreeId,
        tabId,
        leafId,
        agentLaunch: AI_BUTTON
      }
      const context: Parameters<typeof connectIpcPty>[1] = {
        transportOptions,
        handlers: {
          registerData: (id) => {
            renderer.watchers.get(id)?.('claude drawn\r\n\x1b[?2004h> ')
          },
          registerExit: () => false,
          unregisterAll: () => {},
          unregisterData: () => {},
          clearAccumulatedState: () => {}
        },
        isDestroyed: () => false,
        isExpectedExitCurrent: () => true,
        ownsPtyId: () => true,
        bind: (id) => {
          renderer.state.ptyIdsByTabId = { [tabId]: [id] }
          renderer.subscribers.forEach((listener) => listener(renderer.state))
        },
        isCurrent: () => true,
        setCallbacks: () => {},
        getCallbacks: () => ({})
      }
      const connect = () =>
        connectIpcPty({ url: 'ipc://pty', cols: 132, rows: 40, callbacks: {} }, context)
      const connected = connect()
      if (scenario === 'closed-late') {
        await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledOnce())
        noteAgentLaunchPaneClosedByUser(tabId, leafId)
        markAgentLaunchesClosedByUser(worktreeId, { kind: 'pane', tabId, leafId })
        release()
      }
      await connected
      if (scenario === 'remount') {
        // A remount reattaches the established pane, without replaying its startup or delivery.
        providerSpawn.mockResolvedValueOnce({ id: 'pty-agent', isReattach: true })
        await connectIpcPty(
          { url: 'ipc://pty', sessionId: 'pty-agent', cols: 132, rows: 40, callbacks: {} },
          context
        )
        expect(runtime.planAgentPaneLaunch).toHaveBeenCalledOnce()
      }
      const accepted = scenario === 'accepted' || scenario === 'remount'
      await expect(started).resolves.toBe(accepted ? 'pty-agent' : null)
      await expect(delivery).resolves.toMatchObject({ delivered: accepted })
      expect(delivered).toHaveBeenCalledTimes(accepted ? 1 : 0)
      expect(renderer.state.seedNativeChatLaunchPrompt).toHaveBeenCalledTimes(accepted ? 1 : 0)
      expect(renderer.state.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
      expect(renderer.writes.mock.calls.map(([id, data]) => [id, data])).toEqual(
        accepted
          ? [
              ['pty-agent', '\x1b[200~fix checks\x1b[201~'],
              ['pty-agent', '\r']
            ]
          : []
      )
      expect(providerSpawn).toHaveBeenCalledTimes(
        scenario === 'planner-failed' ? 0 : scenario === 'remount' ? 2 : 1
      )
      expect(isAgentLaunchRunningIn(worktreeId, { kind: 'pane', tabId, leafId })).toBe(false)
      expect(renderer.subscribers.size).toBe(0)
      expect(renderer.watchers.size).toBe(0)
      expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
      expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledTimes(
        scenario === 'closed-late' ? 0 : 1
      )
    }
  )

  it('keeps ordinary exited terminal attach and final output when no owned agent was requested', async () => {
    const runtime = register(vi.fn(async () => ({ id: 'pty-agent', snapshot: 'final output' })))
    runtime.registerPty.mockImplementation(() => {
      throw new Error('agent_session_exited_during_start')
    })
    Object.assign(runtime, { getPtyLivenessVerdict: () => ({ status: 'exited' }) })
    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 132,
        rows: 40,
        cwd: '/tmp/pane-launch',
        worktreeId,
        tabId,
        leafId
      })
    ).resolves.toMatchObject({ id: 'pty-agent', snapshot: 'final output' })
    expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalled()
  })
})
