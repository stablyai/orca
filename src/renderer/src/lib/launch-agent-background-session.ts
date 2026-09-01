import { useAppStore } from '@/store'
import type {
  LaunchAgentBackgroundSessionArgs,
  LaunchAgentBackgroundSessionResult
} from '@/lib/agent-background-session-contract'
import { scheduleAgentBackgroundDraft } from '@/lib/agent-background-draft-delivery'
import { AgentLaunchSpawnOutcomeError } from '@/lib/agent-launch-spawn-outcome-error'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { resolveTuiAgentBaseAgent } from '../../../shared/custom-tui-agents'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveTelemetryAgentKind } from '@/lib/telemetry-agent-kind'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  registerEagerPtyBuffer,
  subscribeToPtyExit,
  type EagerPtyHandle
} from '@/components/terminal-pane/pty-dispatcher'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { assertRuntimeSupportsAgentLaunchIdentity } from '@/runtime/agent-launch-identity-negotiation'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { retireProvider, retireUnownedTerminal } from '@/lib/retire-unowned-background-terminal'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  subscribeToRuntimeTerminalData,
  toRemoteRuntimePtyId
} from '@/runtime/runtime-terminal-stream'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalCreateAgentLaunchFailure
} from '../../../shared/runtime-types'
import type { AgentLaunchSpawnRequest } from '../../../shared/agent-launch-spawn-request'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import { isMainTerminalSideEffectAuthorityForPty } from '@/components/terminal-pane/terminal-side-effect-facts-handler'
import { runBestEffortAgentBackgroundCleanups } from '@/lib/agent-background-session-cleanup'
import { bindAutomationTerminal } from '@/lib/automation-terminal-ownership'
import { createBackgroundAgentStatusConsumer } from '@/lib/background-agent-status-consumer'
import { resolveAgentBackgroundLaunchHost } from '@/lib/agent-background-session-launch-host'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { isTerminalTabPresent } from '@/store/slices/terminal-tab-retirement'

export async function launchAgentBackgroundSession(
  args: LaunchAgentBackgroundSessionArgs
): Promise<LaunchAgentBackgroundSessionResult | null> {
  const { agent, worktreeId, prompt, launchSource, title, onData, onExit, onAgentStatus } = args
  const store = useAppStore.getState()
  // Folder workspaces exist only in getKnownWorktreeById.
  const worktree = store.getKnownWorktreeById(worktreeId)
  const repo = worktree ? store.repos.find((entry) => entry.id === worktree.repoId) : null
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  const launchHost = resolveAgentBackgroundLaunchHost({
    store,
    worktreeId,
    worktreePath: worktree.path,
    repo
  })
  // Why: a custom id inherits its base harness's trust preset and prompt-hook
  // gaps; resolve the base from the requested id before reading any built-in-only
  // registry so a custom-based agent behaves like its base and an unresolvable id
  // degrades instead of silently reading `undefined`.
  const baseAgent = resolveTuiAgentBaseAgent(
    agent,
    store.settings?.customTuiAgents,
    store.settings?.deletedCustomTuiAgents
  )
  const preflight = baseAgent ? TUI_AGENT_CONFIG[baseAgent].preflightTrust : undefined
  if (preflight && worktree.path && window.api.agentTrust?.markTrusted) {
    try {
      await window.api.agentTrust.markTrusted({
        preset: preflight,
        workspacePath: worktree.path,
        ...(launchHost.connectionId ? { connectionId: launchHost.connectionId } : {})
      })
    } catch {
      // Best-effort: continue with launch. The user can still accept the trust menu.
    }
  }
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  // Why (U3): the host resolves the requested identity, folds the prompt into the
  // launch command per the resolved base agent's injection mode, and mints the
  // launch token. The client sends identity + prompt only — never a command,
  // launch config, agent env, or the token.
  const agentLaunch: AgentLaunchSpawnRequest = {
    selection: { kind: 'agent', agent },
    prompt: trimmedPrompt,
    ...(hasPrompt ? {} : { allowEmptyPromptLaunch: true })
  }

  // Reserve stable identities without publishing a PTY-less tab.
  const reservedTabId = createBrowserUuid()
  // Why: agent hook callbacks are keyed by pane, and background automation
  // tabs never mount a TerminalPane to inject this env for us. createBrowserUuid
  // (not crypto.randomUUID) because the latter is undefined in non-secure
  // browser contexts — the LAN web client served over plain HTTP.
  const leafId = createBrowserUuid()
  const paneKey = makePaneKey(reservedTabId, leafId)
  // Why (contract B): structural pane-identity env is renderer-owned context —
  // the renderer creates the pane. ORCA_AGENT_LAUNCH_TOKEN is NOT sent; the host
  // injects it from the admission-minted receipt token.
  const paneEnv = {
    ORCA_PANE_KEY: paneKey,
    ORCA_TAB_ID: reservedTabId,
    ORCA_WORKTREE_ID: worktreeId
  }
  const sshConnectionId = launchHost.connectionId
  // Route by the worktree's owner host, not the focused runtime.
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(store, worktreeId)
  )
  let ptyId = ''
  let runtimeTerminalHandle: string | null = null
  let tab: ReturnType<typeof store.createTab> | null = null
  let exitHandled = false
  let eagerPtyBuffer: EagerPtyHandle | null = null
  let terminalOwnership: ReturnType<typeof bindAutomationTerminal> = null
  // Why: the launch token is not known until the host returns the receipt, so
  // capture it (and the resolved launch config) post-spawn for store bookkeeping.
  let launchToken: string | null = null
  let resolvedLaunchConfig: SleepingAgentLaunchConfig | undefined
  // Why: the host returns a followup prompt only when it resolved a stdin-after-
  // start base agent (the prompt cannot fold into the launch command). Capture
  // it locally so the readiness-gated paste writer delivers it after mount; the
  // runtime path delivers its own followup, so this stays local-branch only.
  let localFollowupPrompt: string | null = null
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
    getLaunchToken: () => launchToken,
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
      // The client assembles no command on this path, so a pre-identity host that
      // strips agentLaunch would spawn a bare shell and be reported as launched.
      await assertRuntimeSupportsAgentLaunchIdentity(runtimeTarget.environmentId)
      const created = await callRuntimeRpc<
        { terminal: RuntimeTerminalCreate } | RuntimeTerminalCreateAgentLaunchFailure
      >(
        runtimeTarget,
        'terminal.create',
        {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          agentLaunch,
          env: paneEnv,
          title,
          tabId: reservedTabId,
          leafId,
          // Why: local renderer owns the hidden tab; remote runtime should not reveal UI.
          presentation: 'background'
        },
        { timeoutMs: 15_000 }
      )
      // Why: a pre-spawn host failure/rejection created no terminal — throw the
      // typed outcome (structured failure for the owner record + the localized
      // message) and let the catch retire the hidden tab.
      if (!('terminal' in created)) {
        throw new AgentLaunchSpawnOutcomeError(created.agentLaunch)
      }
      const terminal = created.terminal
      // Why: the runtime terminal-create result is receipt-only (never echoes the
      // resolved launch config); pane identity/attribution rides the receipt token
      // and the status stream, so there is no client config to register here.
      launchToken = terminal.agentLaunch?.receipt.launchToken ?? null
      runtimeTerminalHandle = terminal.handle
      ptyId = toRemoteRuntimePtyId(runtimeTerminalHandle, runtimeTarget.environmentId)
    } else {
      // A WSL UNC worktree needs the pane opened inside the distro shell.
      const wslUncShellOverride =
        !sshConnectionId && isWslUncPath(worktree.path) ? { shellOverride: 'wsl.exe' } : {}
      const result = await window.api.pty.spawn({
        cols: 120,
        rows: 40,
        cwd: worktree.path,
        agentLaunch,
        ...wslUncShellOverride,
        env: paneEnv,
        connectionId: sshConnectionId,
        worktreeId,
        tabId: reservedTabId,
        leafId,
        // Host overwrites agent_kind from the resolved receipt before the emit;
        // stamp the requested id's resolved base so a pre-receipt emit still
        // names the harness instead of collapsing a custom agent to 'other'.
        telemetry: {
          agent_kind: resolveTelemetryAgentKind(agent),
          launch_source: launchSource ?? 'unknown',
          request_kind: 'new'
        }
      })
      // Why: a pre-spawn host failure/rejection has no `id` — throw the typed
      // outcome (structured failure for the owner record + the localized
      // message) and let the catch retire the hidden tab. The preload types that
      // arm with the whole outcome union, so a 'launched' status without a pty id
      // is a broken host contract, never a usable terminal.
      if (!('id' in result)) {
        throw result.agentLaunch.status === 'launched'
          ? new Error('The agent launch reported success without a terminal.')
          : new AgentLaunchSpawnOutcomeError(result.agentLaunch)
      }
      ptyId = result.id
      launchToken =
        result.agentLaunch?.status === 'launched' ? result.agentLaunch.receipt.launchToken : null
      resolvedLaunchConfig = result.launchConfig
      localFollowupPrompt = result.followupPrompt ?? null
    }
    if (
      await retireUnownedTerminal({
        owner: { worktreeId },
        ptyId,
        runtimeTarget,
        runtimeTerminalHandle,
        onRetire: () => {
          exitHandled = true
          store.clearAgentLaunchConfig(paneKey)
        }
      })
    ) {
      return null
    }
    // Why: the spawned process already owns reservedTabId in its pane env; a
    // colliding tab would force createTab to mint a different, invalid identity.
    if (isTerminalTabPresent(useAppStore.getState(), reservedTabId)) {
      store.clearAgentLaunchConfig(paneKey)
      await retireProvider({ ptyId, runtimeTarget, runtimeTerminalHandle })
      return null
    }
    tab = store.createTab(worktreeId, undefined, undefined, {
      id: reservedTabId,
      initialPtyId: ptyId,
      activate: false,
      recordInteraction: false
    })
    // Why: `title` labels the tab/worktree entry. Pane titles render as an
    // in-terminal title row, so background sessions must not persist it there.
    store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId))
    if (resolvedLaunchConfig && launchToken) {
      store.registerAgentLaunchConfig(paneKey, resolvedLaunchConfig, {
        agentType: agent,
        launchToken,
        tabId: tab.id,
        leafId
      })
    }
    terminalOwnership = bindAutomationTerminal(tab, paneKey, ptyId, runtimeTarget.kind, title)
    // Gate on the resolved BASE: a command-code-based custom agent has the same
    // missing prompt-start hook. The status keeps the REQUESTED id below.
    if (baseAgent === 'command-code' && hasPrompt) {
      // Why: Command Code does not expose a prompt-start hook; seed working for
      // hidden prompt launches so sidebar/activity surfaces do not stay idle.
      const routing = agentStatusConsumer.resolveRouting()
      if (routing) {
        const observation = agentStatusConsumer.observeLaunchIngress()
        store.setAgentStatus(
          paneKey,
          { state: 'working', prompt: trimmedPrompt, agentType: agent, observation },
          undefined,
          undefined,
          routing,
          {
            ...(resolvedLaunchConfig ? { launchConfig: resolvedLaunchConfig } : {}),
            ...(launchToken ? { launchToken } : {})
          }
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

    if (localFollowupPrompt) {
      // Why: stdin-after-start agents (aider) receive the prompt as a post-ready
      // bracketed paste + submit, since it could not fold into the launch command.
      scheduleAgentBackgroundDraft(tab.id, localFollowupPrompt, agent)
    }

    return { tabId: tab.id, paneKey, ptyId, terminalOwnership }
  } catch (error) {
    // Why: terminal creation and stream subscription are separate remote calls.
    // A failure between them must not strand an invisible runtime terminal.
    exitHandled = true
    terminalOwnership?.release()
    runBestEffortAgentBackgroundCleanups(unsubscribeExit, unsubscribeData)
    runBestEffortAgentBackgroundCleanups(() => eagerPtyBuffer?.dispose())
    if (tab) {
      const tabId = tab.id
      runBestEffortAgentBackgroundCleanups(() => store.clearTabPtyId(tabId, ptyId))
    }
    runBestEffortAgentBackgroundCleanups(() => store.clearAgentLaunchConfig(paneKey))
    if (ptyId) {
      await retireProvider({ ptyId, runtimeTarget, runtimeTerminalHandle })
    }
    // Why: a launch-failure cleanup close is not a user close — keep it out of
    // the Cmd+Shift+T reopen stack.
    if (tab) {
      const tabId = tab.id
      runBestEffortAgentBackgroundCleanups(() =>
        store.closeTab(tabId, { recordInteraction: false, reason: 'cleanup' })
      )
    }
    throw error
  }
}
