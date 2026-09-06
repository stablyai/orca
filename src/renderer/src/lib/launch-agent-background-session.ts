import { useAppStore } from '@/store'
import { buildBackgroundSessionStartup } from '@/lib/agent-background-session-startup'
import type {
  LaunchAgentBackgroundSessionArgs,
  LaunchAgentBackgroundSessionResult
} from '@/lib/agent-background-session-contract'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { scheduleAgentBackgroundDraft } from '@/lib/agent-background-draft-delivery'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { requireTuiAgentConfig } from '../../../shared/require-tui-agent-config'
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
import {
  createSshBackgroundStartupDelivery,
  sshBackgroundLaunchWaitsForShellReady
} from '@/lib/ssh-background-startup-delivery'
import { isMainTerminalSideEffectAuthorityForPty } from '@/components/terminal-pane/terminal-side-effect-facts-handler'
import { runBestEffortAgentBackgroundCleanups } from '@/lib/agent-background-session-cleanup'
import type { bindAutomationTerminal } from '@/lib/automation-terminal-ownership'
import {
  adoptAgentBackgroundSessionTab,
  reserveAgentBackgroundSessionIdentity
} from '@/lib/adopt-agent-background-session-tab'
import { createBackgroundAgentStatusConsumer } from '@/lib/background-agent-status-consumer'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { runtimeWaitExitCode, settleTabPtyBinding } from '@/lib/agent-background-session-exit'

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
  // Folder launch ownership cannot be derived from a repo row (#2989).
  const launchHost = resolveAgentBackgroundLaunchHost({
    store,
    worktreeId,
    worktreePath: worktree.path,
    repo
  })
  const preflight = agent ? requireTuiAgentConfig(agent).preflightTrust : null
  if (preflight && worktree.path && window.api.agentTrust?.markTrusted) {
    try {
      await window.api.agentTrust.markTrusted({
        preset: preflight,
        workspacePath: worktree.path,
        ...(launchHost.connectionId ? { connectionId: launchHost.connectionId } : {})
      })
    } catch {
      // The user can still accept the agent's trust prompt.
    }
  }
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const plan = buildBackgroundSessionStartup({
    agent,
    prompt: trimmedPrompt,
    settings: store.settings,
    platform: launchHost.platform,
    isRemote: launchHost.isRemote
  })
  if (!plan) {
    return null
  }
  const { startupPlan, startup, pasteDraftAfterLaunch } = plan

  // A hidden run tab must never be store-visible without its PTY (#2989).
  const { reservedTabId, leafId, launchToken, launchRegistration, paneEnv } =
    reserveAgentBackgroundSessionIdentity({
      store,
      agentType: agent,
      worktreeId,
      launchConfig: startup.launchConfig,
      env: startup.env
    })
  let paneKey = makePaneKey(reservedTabId, leafId)
  const sshConnectionId = launchHost.connectionId
  const sshStartupDelivery = createSshBackgroundStartupDelivery({
    command: sshConnectionId ? startup.command : null,
    waitForShellReady:
      Boolean(sshConnectionId) &&
      sshBackgroundLaunchWaitsForShellReady({
        launchCommand: startup.command,
        startupCommandDelivery: startup.startupCommandDelivery
      }),
    write: (ptyId, data) => window.api.pty.write(ptyId, data)
  })
  // Route by the worktree's owner host, not the focused runtime.
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(store, worktreeId)
  )
  let ptyId = '',
    runtimeTerminalHandle: string | null = null
  // Preserve the host's PTY incarnation and effective launch configuration.
  let spawned: { incarnationId?: string; launchConfig?: typeof startup.launchConfig } = {}
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
      settleTabPtyBinding(tab.id, exitPtyId, code)
    }
    useAppStore.getState().clearAgentLaunchConfig(paneKey)
    onExit?.(exitPtyId, code)
  }
  const mainOwnsAgentStatusWrites = isMainTerminalSideEffectAuthorityForPty({
    settings: store.settings,
    runtimeEnvironmentId: runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null
  })
  const agentStatusConsumer = launchToken
    ? createBackgroundAgentStatusConsumer({
        paneKey,
        launchToken,
        mainOwnsAgentStatusWrites,
        expectedConnectionId: launchHost.expectedConnectionId,
        runtimeEnvironmentId:
          runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null,
        getPtyId: () => ptyId,
        onAgentStatus
      })
    : null
  const handleData = (data: string): void => {
    data = sshStartupDelivery.handleData(data)
    onData?.(data)
    sshStartupDelivery.schedule(ptyId)
    agentStatusConsumer?.consume(data)
  }
  try {
    if (runtimeTarget.kind === 'environment') {
      const created = await createRuntimeAgentBackgroundTerminal({
        environmentId: runtimeTarget.environmentId,
        worktreeId,
        tabId: reservedTabId,
        leafId,
        agent,
        ...(hasPrompt && pasteDraftAfterLaunch === null ? { prompt: trimmedPrompt } : {}),
        ...(startupPlan?.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
        legacy: {
          command: startup.command,
          env: paneEnv,
          startupCommandDelivery: startup.startupCommandDelivery,
          launchConfig: startup.launchConfig,
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
        command: startup.command,
        ...(!sshConnectionId && isWslUncPath(worktree.path) ? { shellOverride: 'wsl.exe' } : {}),
        ...(!startup.startupCommandDelivery
          ? {}
          : { startupCommandDelivery: startup.startupCommandDelivery }),
        env: paneEnv,
        launchConfig: startup.launchConfig,
        launchToken,
        ...(agent ? { launchAgent: agent } : {}),
        connectionId: sshConnectionId,
        worktreeId,
        tabId: reservedTabId,
        leafId,
        telemetry: agent
          ? {
              agent_kind: tuiAgentToAgentKind(agent),
              launch_source: launchSource ?? 'unknown',
              request_kind: 'new'
            }
          : undefined
      })
      ptyId = result.id
      spawned = result
      sshStartupDelivery.applyHostShellReadyArmed(result.shellReadyArmed)
    }
    const adopted = await adoptAgentBackgroundSessionTab({
      store,
      worktreeId,
      reservedTabId,
      ptyId,
      paneKey,
      launchConfig: spawned.launchConfig ?? startup.launchConfig,
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
    if (
      agent === 'command-code' &&
      hasPrompt &&
      pasteDraftAfterLaunch === null &&
      agentStatusConsumer
    ) {
      // Command Code has no prompt-start hook, so seed its working state.
      const routing = agentStatusConsumer.resolveRouting()
      if (routing) {
        const observation = agentStatusConsumer.observeLaunchIngress()
        store.setAgentStatus(
          paneKey,
          { state: 'working', prompt: trimmedPrompt, agentType: agent, observation },
          undefined,
          undefined,
          routing,
          { launchConfig: startup.launchConfig, launchToken }
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
      void callRuntimeRpc<{ wait: { satisfied: boolean; exitCode: number | null } }>(
        runtimeTarget,
        'terminal.wait',
        { terminal: runtimeTerminalHandle, for: 'exit' },
        { timeoutMs: 24 * 60 * 60 * 1000 }
      )
        .then(({ wait }) => {
          if (wait.satisfied) {
            handleExit(ptyId, runtimeWaitExitCode(wait))
          }
        })
        .catch(() => {})
    } else {
      // Why the incarnation: a relay-recycled id can hold the previous owner's exit, and draining
      // that into this handler tears the agent session down seconds after it launched.
      eagerPtyBuffer = registerEagerPtyBuffer(ptyId, handleExit, spawned.incarnationId)
      unsubscribeData = subscribeToPtyData(ptyId, handleData)
      // Keep observing exit after a visible terminal replaces the eager handler.
      unsubscribeExit = subscribeToPtyExit(ptyId, (code) => handleExit(ptyId, code))
    }
    sshStartupDelivery.armFallback(ptyId)

    // Bind ownership before mounting to avoid double-spawns or missed user takeover.
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })

    if (pasteDraftAfterLaunch !== null && agent !== null) {
      scheduleAgentBackgroundDraft(tab.id, pasteDraftAfterLaunch, agent)
    }

    return { tabId: tab.id, paneKey, ptyId, startupPlan, terminalOwnership }
  } catch (error) {
    // A failed stream subscription must not strand the terminal it just created.
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
