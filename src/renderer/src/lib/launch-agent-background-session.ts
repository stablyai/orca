import { useAppStore } from '@/store'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import type {
  LaunchAgentBackgroundSessionArgs,
  LaunchAgentBackgroundSessionResult
} from '@/lib/agent-background-session-contract'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { scheduleAgentBackgroundDraft } from '@/lib/agent-background-draft-delivery'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveAgentBackgroundLaunchHost } from '@/lib/agent-background-session-launch-host'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  registerEagerPtyBuffer,
  subscribeToPtyExit,
  type EagerPtyHandle
} from '@/components/terminal-pane/pty-dispatcher'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { retireProvider } from '@/lib/retire-unowned-background-terminal'
import { createRuntimeAgentBackgroundTerminal } from '@/lib/runtime-agent-background-create'
import {
  subscribeToRuntimeTerminalData,
  toRemoteRuntimePtyId
} from '@/runtime/runtime-terminal-stream'
import { createSshBackgroundStartupDelivery } from '@/lib/ssh-background-startup-delivery'
import { shouldUseShellReadyStartupDelivery } from '../../../shared/codex-startup-delivery'
import { isMainTerminalSideEffectAuthorityForPty } from '@/components/terminal-pane/terminal-side-effect-facts-handler'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { runBestEffortAgentBackgroundCleanups } from '@/lib/agent-background-session-cleanup'
import type { bindAutomationTerminal } from '@/lib/automation-terminal-ownership'
import {
  adoptAgentBackgroundSessionTab,
  reserveAgentBackgroundSessionIdentity
} from '@/lib/adopt-agent-background-session-tab'
import { createBackgroundAgentStatusConsumer } from '@/lib/background-agent-status-consumer'
import { isWslUncPath } from '../../../shared/wsl-paths'

export async function launchAgentBackgroundSession(
  args: LaunchAgentBackgroundSessionArgs
): Promise<LaunchAgentBackgroundSessionResult | null> {
  const { agent, worktreeId, prompt, launchSource, title, onData, onExit, onAgentStatus } = args
  const store = useAppStore.getState()
  // Folder workspaces exist only in getKnownWorktreeById (#2989).
  const worktree = store.getKnownWorktreeById(worktreeId)
  const repo = worktree ? store.repos.find((entry) => entry.id === worktree.repoId) : null
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  const agentArgs = resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs)
  const agentEnv = resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv)
  // Folder launch ownership cannot be derived from a repo row (#2989).
  const launchHost = resolveAgentBackgroundLaunchHost({
    store,
    worktreeId,
    worktreePath: worktree.path,
    repo
  })
  const preflight = TUI_AGENT_CONFIG[agent].preflightTrust
  if (preflight && worktree.path && window.api.agentTrust?.markTrusted) {
    try {
      await window.api.agentTrust.markTrusted({
        preset: preflight,
        workspacePath: worktree.path,
        ...(launchHost.connectionId ? { connectionId: launchHost.connectionId } : {})
      })
    } catch {
      // Best-effort: the user can still accept the trust prompt.
    }
  }
  const { platform: launchPlatform, isRemote } = launchHost
  const startupShell = resolveLocalWindowsAgentStartupShell({
    platform: launchPlatform,
    isRemote,
    terminalWindowsShell: store.settings?.terminalWindowsShell
  })
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'

  const pasteDraftAfterLaunch = hasPrompt && isFollowupPath ? trimmedPrompt : null
  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: hasPrompt && !isFollowupPath ? trimmedPrompt : '',
    cmdOverrides,
    agentArgs,
    agentEnv,
    platform: launchPlatform,
    shell: startupShell,
    isRemote,
    allowEmptyPromptLaunch: !hasPrompt || isFollowupPath
  })
  if (!startupPlan) {
    return null
  }

  // A hidden run tab must never be store-visible without its PTY (#2989).
  const { reservedTabId, leafId, launchToken, launchRegistration, paneEnv } =
    reserveAgentBackgroundSessionIdentity({
      store,
      agentType: agent,
      worktreeId,
      launchConfig: startupPlan.launchConfig,
      env: startupPlan.env
    })
  let paneKey = makePaneKey(reservedTabId, leafId)
  const sshConnectionId = launchHost.connectionId
  const sshStartupDelivery = createSshBackgroundStartupDelivery({
    command: sshConnectionId ? startupPlan.launchCommand : null,
    waitForShellReady:
      Boolean(sshConnectionId) &&
      shouldUseShellReadyStartupDelivery({
        command: startupPlan.launchCommand,
        startupCommandDelivery: startupPlan.startupCommandDelivery
      }),
    write: (ptyId, data) => window.api.pty.write(ptyId, data)
  })
  // Route by the worktree's owner host, not the focused runtime.
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(store, worktreeId)
  )
  let ptyId = '',
    runtimeTerminalHandle: string | null = null
  let returnedLaunchConfig: typeof startupPlan.launchConfig | undefined
  let tab: ReturnType<typeof store.createTab> | null = null
  let exitHandled = false,
    eagerPtyBuffer: EagerPtyHandle | null = null
  let terminalOwnership: ReturnType<typeof bindAutomationTerminal> = null
  let unsubscribeExit = (): void => {},
    unsubscribeData = (): void => {}
  const handleExit = (exitPtyId: string, code: number): void => {
    if (exitHandled) {
      return
    }
    exitHandled = true
    unsubscribeExit()
    unsubscribeData()
    sshStartupDelivery.clear()
    if (tab) {
      useAppStore.getState().clearTabPtyId(tab.id, exitPtyId)
    }
    useAppStore.getState().clearAgentLaunchConfig(paneKey)
    onExit?.(exitPtyId, code)
  }
  // Why: local/SSH status facts already pass through main's authoritative
  // scanner; remote-runtime bytes still need this renderer-side store write.
  const mainOwnsAgentStatusWrites = isMainTerminalSideEffectAuthorityForPty({
    settings: store.settings,
    runtimeEnvironmentId: runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null
  })
  const agentStatusConsumer = createBackgroundAgentStatusConsumer({
    paneKey,
    launchToken,
    mainOwnsAgentStatusWrites,
    expectedConnectionId: launchHost.expectedConnectionId,
    runtimeEnvironmentId: runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null,
    getPtyId: () => ptyId,
    onAgentStatus
  })
  const handleData = (data: string): void => {
    data = sshStartupDelivery.handleData(data)
    onData?.(data)
    sshStartupDelivery.schedule(ptyId)
    agentStatusConsumer.consume(data)
  }
  try {
    if (runtimeTarget.kind === 'environment') {
      // Why: runtime environments execute on the server; using local pty.spawn
      // would silently run automation on the client for a remote workspace.
      const created = await createRuntimeAgentBackgroundTerminal({
        environmentId: runtimeTarget.environmentId,
        worktreeId,
        tabId: reservedTabId,
        leafId,
        agent,
        ...(hasPrompt && !isFollowupPath ? { prompt: trimmedPrompt } : {}),
        ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
        legacy: {
          command: startupPlan.launchCommand,
          env: paneEnv,
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {}),
          launchConfig: startupPlan.launchConfig,
          launchToken,
          ...(title ? { title } : {})
        }
      })
      runtimeTerminalHandle = created.terminal.handle
      ptyId = toRemoteRuntimePtyId(runtimeTerminalHandle, runtimeTarget.environmentId)
    } else {
      const result = await window.api.pty.spawn({
        cols: 120,
        rows: 40,
        cwd: worktree.path,
        command: startupPlan.launchCommand,
        ...(!sshConnectionId && isWslUncPath(worktree.path) ? { shellOverride: 'wsl.exe' } : {}),
        ...(!startupPlan.startupCommandDelivery
          ? {}
          : { startupCommandDelivery: startupPlan.startupCommandDelivery }),
        env: paneEnv,
        launchConfig: startupPlan.launchConfig,
        launchToken,
        launchAgent: agent,
        connectionId: sshConnectionId,
        worktreeId,
        tabId: reservedTabId,
        leafId,
        telemetry: {
          agent_kind: tuiAgentToAgentKind(agent),
          launch_source: launchSource ?? 'unknown',
          request_kind: 'new'
        }
      })
      ptyId = result.id
      returnedLaunchConfig = result.launchConfig
    }
    const adopted = await adoptAgentBackgroundSessionTab({
      store,
      worktreeId,
      reservedTabId,
      ptyId,
      paneKey,
      launchConfig: returnedLaunchConfig ?? startupPlan.launchConfig,
      launchRegistration,
      runtimeTarget,
      runtimeTerminalHandle,
      onRetire: () => {
        exitHandled = true
        sshStartupDelivery.clear()
        store.clearAgentLaunchConfig(paneKey)
      },
      ...(title ? { title } : {})
    })
    if (!adopted) {
      return null
    }
    tab = adopted.tab
    paneKey = adopted.paneKey
    terminalOwnership = adopted.terminalOwnership
    if (agent === 'command-code' && hasPrompt && !isFollowupPath) {
      // Why: Command Code does not expose a prompt-start hook; seed working for
      // hidden prompt launches so sidebar/activity surfaces do not stay idle.
      const routing = agentStatusConsumer.resolveRouting()
      if (routing) {
        store.setAgentStatus(
          paneKey,
          { state: 'working', prompt: trimmedPrompt, agentType: agent },
          undefined,
          undefined,
          routing,
          { launchConfig: startupPlan.launchConfig, launchToken }
        )
      }
    }

    if (runtimeTarget.kind === 'environment') {
      if (!runtimeTerminalHandle) {
        throw new Error('Runtime terminal id is invalid.')
      }
      unsubscribeData = await subscribeToRuntimeTerminalData(
        store.settings,
        ptyId,
        `desktop:background:${tab.id}`,
        handleData
      )
      void callRuntimeRpc<{ wait: { exitCode?: number | null } }>(
        runtimeTarget,
        'terminal.wait',
        { terminal: runtimeTerminalHandle, for: 'exit' },
        { timeoutMs: 24 * 60 * 60 * 1000 }
      )
        .then((result) => handleExit(ptyId, result.wait.exitCode ?? 0))
        .catch(() => {})
    } else {
      eagerPtyBuffer = registerEagerPtyBuffer(ptyId, handleExit)
      unsubscribeData = subscribeToPtyData(ptyId, handleData)
      // Why: opening the workspace attaches a real terminal transport and disposes
      // the eager exit handler. This sidecar keeps automation completion tracking
      // alive regardless of whether the tab is hidden or mounted.
      unsubscribeExit = subscribeToPtyExit(ptyId, (code) => handleExit(ptyId, code))
    }
    sshStartupDelivery.armFallback(ptyId)

    // Why: bind the explicit PTY and ownership before mount; an earlier mount
    // can double-spawn, while later tracking can miss user takeover.
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })

    if (pasteDraftAfterLaunch !== null) {
      scheduleAgentBackgroundDraft(tab.id, pasteDraftAfterLaunch, agent)
    }

    return { tabId: tab.id, paneKey, ptyId, startupPlan, terminalOwnership }
  } catch (error) {
    // Why: terminal creation and stream subscription are separate remote calls.
    // A failure between them must not strand an invisible runtime terminal.
    exitHandled = true
    terminalOwnership?.release()
    const createdTab = tab
    runBestEffortAgentBackgroundCleanups(unsubscribeExit, unsubscribeData)
    runBestEffortAgentBackgroundCleanups(() => eagerPtyBuffer?.dispose())
    runBestEffortAgentBackgroundCleanups(() => sshStartupDelivery.clear())
    if (createdTab) {
      runBestEffortAgentBackgroundCleanups(() => store.clearTabPtyId(createdTab.id, ptyId))
    }
    runBestEffortAgentBackgroundCleanups(() => store.clearAgentLaunchConfig(paneKey))
    if (ptyId) {
      await retireProvider({ ptyId, runtimeTarget, runtimeTerminalHandle })
    }
    if (createdTab) {
      // Cleanup closes must not enter the reopen stack.
      runBestEffortAgentBackgroundCleanups(() =>
        store.closeTab(createdTab.id, { recordInteraction: false, reason: 'cleanup' })
      )
    }
    throw error
  }
}
