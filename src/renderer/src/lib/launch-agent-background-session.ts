import { useAppStore } from '@/store'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import type {
  LaunchAgentBackgroundSessionArgs,
  LaunchAgentBackgroundSessionResult
} from '@/lib/agent-background-session-contract'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  registerEagerPtyBuffer,
  subscribeToPtyExit,
  type EagerPtyHandle
} from '@/components/terminal-pane/pty-dispatcher'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  subscribeToRuntimeTerminalData,
  toRemoteRuntimePtyId
} from '@/runtime/runtime-terminal-stream'
import { createAgentStatusOscProcessor } from '../../../shared/agent-status-osc'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import { createSshBackgroundStartupDelivery } from '@/lib/ssh-background-startup-delivery'
import { shouldUseShellReadyStartupDelivery } from '../../../shared/codex-startup-delivery'
import { isMainTerminalSideEffectAuthorityForPty } from '@/components/terminal-pane/terminal-side-effect-facts-handler'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { runBestEffortAgentBackgroundCleanups } from '@/lib/agent-background-session-cleanup'

export async function launchAgentBackgroundSession(
  args: LaunchAgentBackgroundSessionArgs
): Promise<LaunchAgentBackgroundSessionResult | null> {
  const { agent, worktreeId, prompt, launchSource, title, onData, onExit, onAgentStatus } = args
  const store = useAppStore.getState()
  const worktree = store.allWorktrees().find((entry) => entry.id === worktreeId)
  const repo = worktree ? store.repos.find((entry) => entry.id === worktree.repoId) : null
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  const preflight = TUI_AGENT_CONFIG[agent].preflightTrust
  if (preflight && worktree.path && window.api.agentTrust?.markTrusted) {
    try {
      await window.api.agentTrust.markTrusted({
        preset: preflight,
        workspacePath: worktree.path
      })
    } catch {
      // Best-effort: continue with launch. The user can still accept the trust menu.
    }
  }
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  const agentArgs = resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs)
  const agentEnv = resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv)
  const launchPlatform = repo
    ? getAgentLaunchPlatformForRepo(
        repo,
        repo.connectionId ? undefined : getLocalProjectExecutionRuntimeContext(store, worktreeId)
      )
    : CLIENT_PLATFORM
  // Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
  // `orca-ide` rename must not be applied for remote launches.
  const isRemote = repo ? repoIsRemote(repo) : false
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

  // Why: automation runs should start without revealing the workspace.
  // Spawn the PTY immediately, then attach an inactive tab to the live session.
  const tab = store.createTab(worktreeId, undefined, undefined, {
    activate: false,
    recordInteraction: false
  })
  if (title) {
    store.setTabCustomTitle(tab.id, title, { recordInteraction: false })
  }
  // Why: agent hook callbacks are keyed by pane, and background automation
  // tabs never mount a TerminalPane to inject this env for us. createBrowserUuid
  // (not crypto.randomUUID) because the latter is undefined in non-secure
  // browser contexts — the LAN web client served over plain HTTP.
  const leafId = createBrowserUuid()
  const paneKey = makePaneKey(tab.id, leafId)
  const launchToken = createBrowserUuid()
  store.registerAgentLaunchConfig(paneKey, startupPlan.launchConfig, {
    agentType: agent,
    launchToken,
    tabId: tab.id,
    leafId
  })
  // Why: `title` labels the tab/worktree entry. Pane titles render as an
  // in-terminal title row, so background sessions must not persist it there.
  store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId))
  const paneEnv = {
    ...startupPlan.env,
    ORCA_PANE_KEY: paneKey,
    ORCA_TAB_ID: tab.id,
    ORCA_WORKTREE_ID: worktreeId,
    ORCA_AGENT_LAUNCH_TOKEN: launchToken
  }
  const sshConnectionId = repo?.connectionId ?? null
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
  let ptyId = ''
  let runtimeTerminalHandle: string | null = null
  let exitHandled = false
  let eagerPtyBuffer: EagerPtyHandle | null = null
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
    useAppStore.getState().clearTabPtyId(tab.id, exitPtyId)
    useAppStore.getState().clearAgentLaunchConfig(paneKey)
    onExit?.(exitPtyId, code)
  }
  // Why: local/SSH status facts already pass through main's authoritative
  // scanner; remote-runtime bytes still need this renderer-side store write.
  const mainOwnsAgentStatusWrites = isMainTerminalSideEffectAuthorityForPty({
    settings: store.settings,
    runtimeEnvironmentId: runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null
  })
  const processAgentStatus = createAgentStatusOscProcessor()
  const handleData = (data: string): void => {
    data = sshStartupDelivery.handleData(data)
    onData?.(data)
    sshStartupDelivery.schedule(ptyId)
    const processed = processAgentStatus(data)
    for (const payload of processed.payloads) {
      if (!mainOwnsAgentStatusWrites) {
        useAppStore.getState().setAgentStatus(paneKey, payload, undefined, undefined, undefined, {
          launchToken
        })
      }
      onAgentStatus?.(payload)
    }
  }
  try {
    if (runtimeTarget.kind === 'environment') {
      // Why: runtime environments execute on the server; using local pty.spawn
      // would silently run automation on the client for a remote workspace.
      const created = await callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
        runtimeTarget,
        'terminal.create',
        {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          command: startupPlan.launchCommand,
          launchConfig: startupPlan.launchConfig,
          launchToken,
          launchAgent: agent,
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {}),
          env: paneEnv,
          title,
          tabId: tab.id,
          leafId,
          // Why: local renderer owns the hidden tab; remote runtime should not reveal UI.
          presentation: 'background'
        },
        { timeoutMs: 15_000 }
      )
      runtimeTerminalHandle = created.terminal.handle
      ptyId = toRemoteRuntimePtyId(runtimeTerminalHandle, runtimeTarget.environmentId)
    } else {
      const result = await window.api.pty.spawn({
        cols: 120,
        rows: 40,
        cwd: worktree.path,
        command: startupPlan.launchCommand,
        ...(!startupPlan.startupCommandDelivery
          ? {}
          : { startupCommandDelivery: startupPlan.startupCommandDelivery }),
        env: paneEnv,
        launchConfig: startupPlan.launchConfig,
        launchToken,
        launchAgent: agent,
        connectionId: sshConnectionId,
        worktreeId,
        tabId: tab.id,
        leafId,
        telemetry: {
          agent_kind: tuiAgentToAgentKind(agent),
          launch_source: launchSource ?? 'unknown',
          request_kind: 'new'
        }
      })
      ptyId = result.id
      if (result.launchConfig) {
        store.registerAgentLaunchConfig(paneKey, result.launchConfig, {
          agentType: agent,
          launchToken,
          tabId: tab.id,
          leafId
        })
      }
    }
    store.updateTabPtyId(tab.id, ptyId)
    store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId, ptyId))
    if (agent === 'command-code' && hasPrompt && !isFollowupPath) {
      // Why: Command Code does not expose a prompt-start hook; seed working for
      // hidden prompt launches so sidebar/activity surfaces do not stay idle.
      store.setAgentStatus(
        paneKey,
        {
          state: 'working',
          prompt: trimmedPrompt,
          agentType: agent
        },
        undefined,
        undefined,
        undefined,
        { launchConfig: startupPlan.launchConfig, launchToken }
      )
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

    // Why: mount only after the explicit PTY is bound. Mounting at the earlier
    // createTab boundary lets a slow SSH/remote spawn race TerminalPane's fresh
    // spawn path and launch the agent twice.
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })

    if (pasteDraftAfterLaunch !== null) {
      void pasteDraftWhenAgentReady({
        tabId: tab.id,
        content: pasteDraftAfterLaunch,
        agent,
        submit: true,
        onTimeout: () => showAutomationPromptNotSentToast(agent)
      })
    }

    return { tabId: tab.id, paneKey, ptyId, startupPlan }
  } catch (error) {
    // Why: terminal creation and stream subscription are separate remote calls.
    // A failure between them must not strand an invisible runtime terminal.
    exitHandled = true
    runBestEffortAgentBackgroundCleanups(unsubscribeExit, unsubscribeData)
    runBestEffortAgentBackgroundCleanups(() => eagerPtyBuffer?.dispose())
    runBestEffortAgentBackgroundCleanups(() => sshStartupDelivery.clear())
    runBestEffortAgentBackgroundCleanups(() => store.clearTabPtyId(tab.id, ptyId))
    runBestEffortAgentBackgroundCleanups(() => store.clearAgentLaunchConfig(paneKey))
    if (ptyId) {
      try {
        if (runtimeTarget.kind === 'environment' && runtimeTerminalHandle) {
          await callRuntimeRpc(runtimeTarget, 'terminal.close', {
            terminal: runtimeTerminalHandle
          })
        } else if (runtimeTarget.kind === 'local') {
          await window.api.pty.kill(ptyId)
        }
      } catch {
        // Best-effort close; retiring the invalid hidden tab must still proceed.
      }
    }
    runBestEffortAgentBackgroundCleanups(() => store.closeTab(tab.id, { recordInteraction: false }))
    throw error
  }
}
