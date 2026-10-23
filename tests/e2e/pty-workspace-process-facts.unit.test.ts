import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../src/shared/project-types'
import { setupPtyIpcSuite } from '../../src/main/ipc/pty-ipc-test-harness'
import {
  startParityLanes,
  setMainPlatform,
  restoreMainPlatform
} from '../../src/main/ipc/pty-launch-parity.test-fixture'
import { WIN_PATH } from '../../src/shared/launch-parity-window-cases.test-fixture'
import { launchWorkspaceId } from '../../src/shared/launch-parity-window-request.test-fixture'

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({
      tabsByWorktree: {},
      ptyProcessMetadataById: {},
      ptyProcessObservationRevision: 0,
      agentStatusByPaneKey: {}
    }))
  }
})

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
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../../src/main/ipc/pty-ipc-mock-registry')).fsPromisesModuleMock(
    await importOriginal()
  )
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
// Why: an OpenCode v2 install with the picked model available; the probes would run the binary.
vi.mock('../../src/main/managed-data-accounts/launch-environment', () => ({
  applyManagedDataAccountEnvironment: vi.fn()
}))
vi.mock('../../src/main/opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: vi.fn()
}))
vi.mock('../../src/main/opencode/opencode-model-availability', () => ({
  resolveOpenCodeDirectModelExecutable: vi.fn(),
  probeOpenCodeModelAvailability: vi.fn()
}))
vi.mock('../../src/main/opencode/opencode-launch-model-context', () => ({
  probeOpenCodeLaunchModelContext: vi.fn()
}))
// Why: every folder in the table exists on its host; main checks that before it spawns.
vi.mock('../../src/main/project-groups/folder-workspace-path-status', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFolderWorkspacePathStatus: vi.fn(async () => ({ path: '', exists: true }))
}))
// Why: no Antigravity account is selected on this machine, so the account switch before an agy launch is a no-op.
vi.mock('../../src/main/antigravity/native-account-launch', () => ({
  prepareAntigravityAccountForLaunch: vi.fn(async () => {})
}))
vi.mock('../../src/main/codex/codex-state-db-backfill-recovery', () =>
  import('../../src/main/ipc/pty-ipc-mock-registry').then((m) =>
    m.codexBackfillRecoveryModuleMock()
  )
)
// Why: the OpenSSH DefaultShell registry read; only a managed SSH host's case answers it.
vi.mock('../../src/shared/openssh-default-shell', () => ({
  readOpenSshDefaultShell: vi.fn(() => '')
}))

const WSL_UBUNTU = { kind: 'wsl', distro: 'Ubuntu' } as const

describe('owning process facts through host recovery and renderer consumers', () => {
  const suite = setupPtyIpcSuite()
  afterEach(() => {
    restoreMainPlatform()
    vi.unstubAllEnvs()
  })
  it('describes the winning native shell after host policy changes during IPC recovery', async () => {
    setMainPlatform('win32')
    const workspace = { kind: 'repo', path: WIN_PATH, projectRuntime: WSL_UBUNTU } as const
    const projects: Pick<Project, 'id' | 'sourceRepoIds' | 'localWindowsRuntimePreference'>[] = [
      { id: 'project-1', sourceRepoIds: ['repo-1'], localWindowsRuntimePreference: WSL_UBUNTU }
    ]
    const lanes = startParityLanes(suite, { workspace, projects })
    const entered = Promise.withResolvers<void>()
    const recovery = Promise.withResolvers<boolean>()
    const spawn = vi.fn(async (options: { shellOverride?: string }) => ({
      id: 'observed-native',
      shellPath: options.shellOverride,
      wslDistro: null,
      incarnationId: '5b3b5ff4-23b1-4000-8000-000000000001'
    }))
    suite.installDaemonTestProvider({
      spawn,
      listProcesses: async () => [
        {
          id: 'observed-native',
          cwd: WIN_PATH,
          title: 'shell',
          shellPath: spawn.mock.calls[0]?.[0].shellOverride,
          wslDistro: null,
          incarnationId: '5b3b5ff4-23b1-4000-8000-000000000001'
        }
      ],
      routesFreshSpawnsToLocalProvider: true,
      recoverFreshSpawnRouting: () => {
        entered.resolve()
        return recovery.promise
      }
    })
    const { installIpcPtyWindow, restorePtySpecWindow } =
      await import('../../src/renderer/src/components/terminal-pane/pty-transport-test-harness')
    const { createIpcPtyTransport } =
      await import('../../src/renderer/src/components/terminal-pane/pty-transport')
    const { resolveTerminalInputHostPlatform } =
      await import('../../src/renderer/src/components/terminal-pane/terminal-input-host-platform')
    const { resolveTerminalPasteRuntime } =
      await import('../../src/renderer/src/components/terminal-pane/terminal-paste-runtime')
    const { isLocalWindowsConptyPaneForCtrlArrow } =
      await import('../../src/renderer/src/components/terminal-pane/terminal-ctrl-arrow-conpty')
    const { resolveDashboardCardTerminalInput } =
      await import('../../src/renderer/src/components/dashboard/dashboard-card-terminal-input')
    const { useAppStore } = await import('../../src/renderer/src/store')
    const { ShellIcon } = await import('../../src/renderer/src/components/tab-bar/shell-icons')
    const { Terminal } = await import('@xterm/headless')
    const { refreshPaneProcessCapabilities } =
      await import('../../src/renderer/src/components/terminal-pane/pty-connection/pane-host-capability-flags')
    const { bindCaptureTransportOutputCallbacks } =
      await import('../../src/renderer/src/components/terminal-pane/pty-connection/transport-output-callbacks')
    const { installPaneAgentIdentity } =
      await import('../../src/renderer/src/components/terminal-pane/pty-connection/pane-agent-identity')
    const { readTerminalTabShell } =
      await import('../../src/renderer/src/store/terminals/terminal-process-metadata')
    const { installTerminalCapabilityReplyHandlers, CONPTY_DA1_RESPONSE } =
      await import('../../src/renderer/src/components/terminal-pane/terminal-capability-replies')
    const originalWindow = globalThis.window
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    let output: ((event: { id: string; data: string }) => void) | undefined
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        output = callback
      }
    })
    vi.mocked(window.api.pty.spawn).mockImplementation(async (request) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real handler returns the preload spawn contract.
      const answer = (await lanes.spawnWindow(request)) as Awaited<
        ReturnType<typeof window.api.pty.spawn>
      >
      output?.({ id: answer.id, data: '\x1b[c' })
      return answer
    })
    const transport = createIpcPtyTransport({
      cwd: WIN_PATH,
      shellOverride: 'wsl.exe',
      worktreeId: launchWorkspaceId(workspace),
      bufferInputUntilConnect: true
    })
    const terminal = new Terminal({ allowProposedApi: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every field read by the real compatibility refresh.
    const paneSession = {
      transport,
      pane: { terminal, id: 1 },
      deps: {
        worktreeId: launchWorkspaceId(workspace),
        tabId: 't',
        cwd: '\\\\wsl$\\Stale\\src',
        paneTransportsRef: { current: new Map([[1, transport]]) },
        isVisibleRef: { current: false }
      },
      transportStreamGeneration: 0,
      createProcessExitState: () => ({ detector: { observe: vi.fn() } }),
      reportRemoteRendererSerializerReady: vi.fn(),
      syncHiddenRendererPtyDelivery: vi.fn(),
      dataCallback: (chunk: string) => {
        expect(paneSession.isNativeWindowsConpty).toBe(true)
        terminal.write(chunk)
      },
      cacheKey: 't:p',
      executionHostId: 'local',
      isNativeWindowsConpty: false
    } as unknown as Parameters<typeof refreshPaneProcessCapabilities>[0]
    bindCaptureTransportOutputCallbacks(paneSession)
    installPaneAgentIdentity(paneSession)
    const replies = installTerminalCapabilityReplyHandlers({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: headless and renderer terminals share the parser/options contract used here.
      terminal: terminal as never,
      parser: terminal.parser,
      isReplaying: () => false,
      sendInput: (reply) => transport.sendInputImmediate(reply),
      da1Response: () => (paneSession.isNativeWindowsConpty ? CONPTY_DA1_RESPONSE : undefined)
    })
    vi.mocked(window.api.pty.writeAccepted).mockImplementation(async () => {
      expect(paneSession.isNativeWindowsConpty).toBe(true)
      return true
    })
    const earlyInput = transport.sendInputAccepted?.('before connect', 'driving')
    try {
      const starting = transport.connect({
        url: '',
        callbacks: paneSession.captureTransportOutputCallbacks(() => {}, {}).callbacks
      })
      await entered.promise
      projects.splice(0, 1, {
        id: 'project-1',
        sourceRepoIds: ['repo-1'],
        localWindowsRuntimePreference: { kind: 'windows-host' }
      })
      recovery.resolve(true)
      await starting
      expect(await earlyInput).toBe(true)
      await new Promise<void>((resolve) => terminal.write('', resolve))
      expect(paneSession.isForegroundTrackingAllowed('observed-native')).toBe(true)
      expect(paneSession.shouldProtectNativeWindowsSynchronizedOutput).toBe(true)
      expect(paneSession.shouldApplyNativeWindowsRewriteRefresh).toBe(true)
      expect(terminal.options.windowsPty).toMatchObject({ backend: 'conpty' })
      expect(terminal.options.vtExtensions?.kittyKeyboard).toBe(false)
      expect(window.api.pty.write).toHaveBeenCalledWith(
        'observed-native',
        CONPTY_DA1_RESPONSE,
        'query-reply'
      )
      expect(window.api.pty.writeAccepted).toHaveBeenCalledWith(
        'observed-native',
        'before connect',
        'driving'
      )
      const actualShell = spawn.mock.calls[0][0].shellOverride
      expect(actualShell?.toLowerCase()).toContain('cmd.exe')
      expect(
        await suite.handlers.get('pty:listSessions')!(null, { connectionId: null })
      ).toMatchObject([
        {
          id: 'observed-native',
          shellPath: actualShell,
          wslDistro: null,
          incarnationId: '5b3b5ff4-23b1-4000-8000-000000000001'
        }
      ])
      useAppStore.setState({ ptyIdsByTabId: { t: ['observed-native'] } })
      const state = useAppStore.getState()
      const observedShell = readTerminalTabShell(state, { id: 't', shellOverride: 'wsl.exe' })
      expect(observedShell).toBe(actualShell)
      expect(ShellIcon({ shell: observedShell }).type).toBe(ShellIcon({ shell: 'cmd.exe' }).type)
      expect(
        resolveTerminalInputHostPlatform({
          clientPlatform: 'win32',
          state,
          worktreeId: launchWorkspaceId(workspace),
          transport
        })
      ).toBe('win32')
      expect(transport.getLocalSessionMetadata?.()?.shellOverride).toBe(actualShell)
      expect(
        resolveTerminalPasteRuntime({ platform: 'win32', ptyId: transport.getPtyId(), transport })
          .kind
      ).toBe('local')
      expect(
        isLocalWindowsConptyPaneForCtrlArrow({
          isWindows: true,
          userAgent: 'Windows',
          state,
          worktreeId: launchWorkspaceId(workspace),
          tabId: 't',
          paneId: 1,
          paneCwd: new Map(),
          fallbackCwd: WIN_PATH,
          transport
        })
      ).toBe(true)
      expect(
        resolveDashboardCardTerminalInput(state, {
          ptyId: 'observed-native',
          worktreeId: launchWorkspaceId(workspace),
          paneKey: 't:p',
          cwd: WIN_PATH,
          shellOverride: 'wsl.exe',
          launchAgent: null,
          clientPlatform: 'win32',
          userAgent: 'Windows',
          osRelease: '10.0.26100'
        })
      ).toMatchObject({ hostPlatform: 'win32', localWindowsConpty: true })
    } finally {
      transport.detach?.()
      paneSession.paneForegroundAgentTracker.dispose()
      replies.dispose()
      terminal.dispose()
      restorePtySpecWindow(originalWindow)
      vi.unstubAllGlobals()
    }
  })
})
