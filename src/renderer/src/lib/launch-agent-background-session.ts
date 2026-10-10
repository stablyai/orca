import { useAppStore } from '@/store'
import type {
  LaunchAgentBackgroundSessionArgs,
  LaunchAgentBackgroundSessionResult
} from '@/lib/agent-background-session-contract'
import { scheduleAgentBackgroundDraft } from '@/lib/agent-background-draft-delivery'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
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
import { spawnBackgroundRunPty } from '@/lib/background-run-host-spawn'
import {
  buildBackgroundRunPtySpawn,
  buildBackgroundRunStartup
} from '../../../shared/background-run-launch'

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
  const { platform: launchPlatform, isRemote } = launchHost
  // Route by the worktree's owner host, not the focused runtime.
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(store, worktreeId)
  )
  if (hasExtraAgentArgs(args.extraAgentArgs) && runtimeTarget.kind === 'environment') {
    // Why: that server rebuilds the command from its own settings and would drop the extras.
    throw new Error("Extra arguments can't be applied to a paired server's workspace from here.")
  }
  // Why before any tab or PTY: an invalid launch must fail the run without creating a terminal.
  const startup = buildBackgroundRunStartup({
    agent,
    settings: store.settings ?? {},
    platform: launchPlatform,
    isRemote,
    extraAgentArgs: args.extraAgentArgs,
    prompt
  })
  if (!startup) {
    return null
  }
  const { plan: startupPlan, commandPrompt, pastePromptAfterStart } = startup

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
  // What the local spawn answered and later steps still need: which lifetime of `ptyId` this launch
  // owns, and the config the host actually launched. Both absent for a runtime terminal.
  let spawned: { incarnationId?: string; launchConfig?: typeof startupPlan.launchConfig } = {}
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
    if (tab) {
      settleTabPtyBinding(tab.id, exitPtyId, code)
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
    onData?.(data)
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
        ...(commandPrompt ? { prompt: commandPrompt } : {}),
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
      const result = await spawnBackgroundRunPty({
        agent,
        worktreeId,
        ...(commandPrompt ? { commandPrompt } : {}),
        ...(args.extraAgentArgs ? { extraAgentArgs: args.extraAgentArgs } : {}),
        ...(title ? { title } : {}),
        ...(launchSource ? { launchSource } : {}),
        launchPlatform,
        spawn: buildBackgroundRunPtySpawn({
          agent,
          plan: startupPlan,
          cwd: worktree.path,
          worktreeId,
          sshConnectionId,
          env: paneEnv,
          launchToken,
          tabId: reservedTabId,
          leafId,
          ...(title ? { title } : {}),
          ...(launchSource ? { launchSource } : {})
        })
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
    if (agent === 'command-code' && commandPrompt) {
      // Why: Command Code does not expose a prompt-start hook; seed working for
      // hidden prompt launches so sidebar/activity surfaces do not stay idle.
      const routing = agentStatusConsumer.resolveRouting()
      if (routing) {
        const observation = agentStatusConsumer.observeLaunchIngress()
        store.setAgentStatus(
          paneKey,
          { state: 'working', prompt: commandPrompt, agentType: agent, observation },
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
        .then((result) => handleExit(ptyId, runtimeWaitExitCode(result.wait)))
        .catch(() => {})
    } else {
      // Why the incarnation: a relay-recycled id can hold the previous owner's exit, and draining
      // that into this handler tears the agent session down seconds after it launched.
      eagerPtyBuffer = registerEagerPtyBuffer(ptyId, handleExit, spawned.incarnationId)
      unsubscribeData = subscribeToPtyData(ptyId, handleData)
      // Why: opening the workspace attaches a real terminal transport and disposes
      // the eager exit handler. This sidecar keeps automation completion tracking
      // alive regardless of whether the tab is hidden or mounted.
      unsubscribeExit = subscribeToPtyExit(ptyId, (code) => handleExit(ptyId, code))
    }
    // Why: bind the explicit PTY and ownership before mount; an earlier mount
    // can double-spawn, while later tracking can miss user takeover.
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })

    if (pastePromptAfterStart !== null) {
      scheduleAgentBackgroundDraft(tab.id, pastePromptAfterStart, agent)
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
