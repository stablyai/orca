import { ensureAgentLaunchPreferences } from '@/components/settings/use-host-agent-launch-preferences'
import { useAppStore } from '@/store'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import type {
  LaunchAgentBackgroundSessionArgs,
  LaunchAgentBackgroundSessionResult
} from '@/lib/agent-background-session-contract'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { scheduleAgentBackgroundDraft } from '@/lib/agent-background-draft-delivery'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-startup-plan-inputs'
import { requireTuiAgentConfig } from '../../../shared/require-tui-agent-config'
import { resolveAgentBackgroundLaunchContext } from '@/lib/agent-background-session-launch-host'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  registerEagerPtyBuffer,
  subscribeToPtyExit,
  type EagerPtyHandle
} from '@/components/terminal-pane/pty-dispatcher'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { retireProvider } from '@/lib/retire-unowned-background-terminal'
import { prepareRuntimeAgentBackgroundTerminal } from '@/lib/runtime-agent-background-create'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { isMainTerminalSideEffectAuthorityForPty } from '@/components/terminal-pane/terminal-side-effect-facts-handler'
import { hasExtraAgentArgs } from '../../../shared/automation-extra-agent-args'
import { runBestEffortAgentBackgroundCleanups } from '@/lib/agent-background-session-cleanup'
import type { bindAutomationTerminal } from '@/lib/automation-terminal-ownership'
import {
  adoptAgentBackgroundSessionTab,
  reserveAgentBackgroundSessionIdentity
} from '@/lib/adopt-agent-background-session-tab'
import { createBackgroundAgentStatusConsumer } from '@/lib/background-agent-status-consumer'
import { runtimeWaitExitCode, settleTabPtyBinding } from '@/lib/agent-background-session-exit'
import { isWslUncPath } from '../../../shared/wsl-paths'

export async function launchAgentBackgroundSession(
  args: LaunchAgentBackgroundSessionArgs
): Promise<LaunchAgentBackgroundSessionResult | null> {
  const { agent, worktreeId, prompt, launchSource, title, onData, onExit, onAgentStatus } = args
  const store = useAppStore.getState()
  // Folder workspaces exist only in getKnownWorktreeById (#2989).
  const worktree = args.resolvedTarget?.worktree ?? store.getKnownWorktreeById(worktreeId)
  const repo =
    args.resolvedTarget?.repo ??
    (worktree ? store.repos.find((entry) => entry.id === worktree.repoId) : null)
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  // Folder launch ownership cannot be derived from a repo row (#2989).
  const { launchHost, runtimeTarget, executionFacts } = resolveAgentBackgroundLaunchContext({
    store,
    worktreeId,
    worktreePath: worktree.path,
    repo,
    resolvedTarget: args.resolvedTarget
  })
  const { platform: launchPlatform, isRemote, isLocalHost } = launchHost
  if (hasExtraAgentArgs(args.extraAgentArgs) && runtimeTarget.kind === 'environment') {
    // Why: that server rebuilds the command from its own settings and would drop the extras.
    throw new Error("Extra arguments can't be applied to a paired server's workspace from here.")
  }
  const createRuntimeTerminal =
    runtimeTarget.kind === 'environment'
      ? await prepareRuntimeAgentBackgroundTerminal(runtimeTarget.environmentId)
      : null
  const preferences = await ensureAgentLaunchPreferences(useAppStore.getState(), {
    kind: 'git-worktree',
    runtimeEnvironmentId: runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null
  })
  // Why before any tab or PTY: an invalid launch must fail the run without creating a terminal.
  const planInputs = resolveAgentStartupPlanInputs({
    agent,
    // Why: the client's Windows shell setting describes this machine, not a remote host.
    settings: {
      ...store.settings,
      agentLaunchChoices: preferences.agentLaunchChoices ?? store.settings?.agentLaunchChoices,
      ...(!isLocalHost ? { terminalWindowsShell: undefined } : {})
    },
    platform: launchPlatform,
    isRemote,
    // The window quotes by its Settings shell, which its pane's spawn also reads.
    shell: undefined,
    extraAgentArgs: args.extraAgentArgs,
    suppressStartupUpdatePrompt: true
  })
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = requireTuiAgentConfig(agent).promptInjectionMode === 'stdin-after-start'

  const pasteDraftAfterLaunch = hasPrompt && isFollowupPath ? trimmedPrompt : null
  const startupPlan = buildAgentStartupPlan({
    ...planInputs,
    prompt: hasPrompt && !isFollowupPath ? trimmedPrompt : '',
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
  let ptyId = '',
    runtimeTerminalHandle: string | null = null
  // Capture local/SSH incarnation and actual launch config for later steps; runtime terminals supply neither.
  let spawned: { incarnationId?: string; launchConfig?: typeof startupPlan.launchConfig } = {}
  let tab: ReturnType<typeof store.createTab> | null = null
  let exitHandled = false,
    eagerPtyBuffer: EagerPtyHandle | null = null
  let terminalOwnership: ReturnType<typeof bindAutomationTerminal> = null
  let unsubscribeExit = (): void => {},
    unsubscribeData = (): void => {},
    releaseRuntimeObservers = (): void => {}
  const handleExit = (exitPtyId: string, code: number): void => {
    if (exitHandled) {
      return
    }
    exitHandled = true
    unsubscribeExit()
    unsubscribeData()
    if (tab) {
      settleTabPtyBinding(tab.id, exitPtyId, code)
    }
    useAppStore.getState().clearAgentLaunchConfig(paneKey)
    onExit?.(exitPtyId, code)
  }
  // Main owns local/SSH status scanning; runtime bytes still need renderer-side writes.
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
    onData?.(data)
    agentStatusConsumer.consume(data)
  }
  try {
    if (runtimeTarget.kind === 'environment' && createRuntimeTerminal) {
      // Runtime workspaces execute on their server; local pty.spawn would run automation on this client.
      const created = await createRuntimeTerminal({
        environmentId: runtimeTarget.environmentId,
        worktreeId,
        tabId: reservedTabId,
        leafId,
        agent,
        ...(hasPrompt && !isFollowupPath ? { prompt: trimmedPrompt } : {}),
        legacy: {
          ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
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
        // Why: the relay types, waits for the shell and stages long lines on the host that owns the PTY.
        ...(sshConnectionId
          ? { commandDelivery: 'provider' as const, startupCommandDelivery: 'shell-ready' as const }
          : startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {}),
        env: paneEnv,
        launchConfig: startupPlan.launchConfig,
        launchToken,
        launchAgent: agent,
        connectionId: sshConnectionId,
        ...(executionFacts?.projectRuntime
          ? { projectRuntime: executionFacts.projectRuntime }
          : {}),
        worktreeId,
        tabId: reservedTabId,
        leafId,
        // Why no launchAgent: the adopted tab is created without one, and the row must match it.
        placement: { kind: 'new-tab', ...(title ? { row: { customTitle: title } } : {}) },
        telemetry: {
          agent_kind: tuiAgentToAgentKind(agent),
          launch_source: launchSource ?? 'unknown',
          request_kind: 'new'
        }
      })
      ptyId = result.id
      spawned = result
    }
    const adopted = await adoptAgentBackgroundSessionTab({
      store,
      worktreeId,
      reservedTabId,
      ptyId,
      paneKey,
      launchConfig: spawned.launchConfig ?? startupPlan.launchConfig,
      launchRegistration,
      runtimeTarget,
      runtimeTerminalHandle,
      executionFacts,
      onRetire: () => {
        exitHandled = true
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
      // Command Code lacks prompt-start hooks; seed working for hidden prompt launches until real status arrives.
      const routing = agentStatusConsumer.resolveRouting()
      if (routing) {
        const observation = agentStatusConsumer.observeLaunchIngress()
        store.setAgentStatus(
          paneKey,
          { state: 'working', prompt: trimmedPrompt, agentType: agent, observation },
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
        ptyId,
        `desktop:background:${tab.id}`,
        handleData
      )
      const exitWait = new AbortController()
      // Kept-open terminals never exit; cancel their server wait instead of retaining a 24h long-wait slot.
      releaseRuntimeObservers = () => {
        releaseRuntimeObservers = (): void => {}
        exitWait.abort()
        const closeData = unsubscribeData
        unsubscribeData = (): void => {}
        closeData()
      }
      void callRuntimeRpc<{ wait: { exitCode?: number | null } }>(
        runtimeTarget,
        'terminal.wait',
        { terminal: runtimeTerminalHandle, for: 'exit' },
        { timeoutMs: 24 * 60 * 60 * 1000, signal: exitWait.signal }
      )
        .then((result) => handleExit(ptyId, runtimeWaitExitCode(result.wait)))
        .catch(() => {})
    } else {
      // Incarnation prevents recycled relay IDs from delivering the previous session’s exit.
      eagerPtyBuffer = registerEagerPtyBuffer(ptyId, handleExit, spawned.incarnationId)
      unsubscribeData = subscribeToPtyData(ptyId, handleData)
      // A mounted transport disposes the eager exit handler; this sidecar preserves completion tracking across hidden/visible transitions.
      unsubscribeExit = subscribeToPtyExit(ptyId, (code) => handleExit(ptyId, code))
    }
    // Bind PTY/ownership before mount to prevent duplicate spawn without missing user takeover.
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })

    if (pasteDraftAfterLaunch !== null) {
      scheduleAgentBackgroundDraft(tab.id, pasteDraftAfterLaunch, agent)
    }

    return {
      tabId: tab.id,
      paneKey,
      ptyId,
      startupPlan,
      terminalOwnership,
      releaseRuntimeObservers: () => releaseRuntimeObservers()
    }
  } catch (error) {
    // Creation and subscription are separate RPCs; failure between them must clean up the invisible runtime terminal.
    exitHandled = true
    terminalOwnership?.release()
    const createdTab = tab
    runBestEffortAgentBackgroundCleanups(unsubscribeExit, unsubscribeData)
    runBestEffortAgentBackgroundCleanups(() => eagerPtyBuffer?.dispose())
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
