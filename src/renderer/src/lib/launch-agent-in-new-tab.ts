import {
  launchNewTabPromptThroughHost,
  newTabPromptLaunchesThroughHost
} from '@/lib/launch-agent-new-tab-host-route'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab-args'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { invalidTerminalArgsMessage } from './launch-work-item-direct-messages'
import {
  agentLaunchCheckSettingsMessage,
  agentLaunchRecoveryMessage,
  notifyAgentLaunchFailure
} from './agent-launch-failure'
import { planLaunchAgentStartupPrompt } from '@/lib/launch-agent-startup-prompt-plan'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { pasteAgentLaunchPromptOnceReady } from '@/lib/launch-agent-tab-prompt-paste'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { launchAgentInWebHostTab } from '@/lib/launch-agent-web-host-tab'
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-startup-plan-inputs'
import { readAgentLaunchPreferencesForWorktree } from '@/components/settings/use-host-agent-launch-preferences'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveAgentLaunchExecutionContext } from '@/lib/launch-agent-execution-context'
import { launchStructuredAgentFromNewTab } from '@/lib/launch-agent-in-new-tab-structured-route'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import {
  launchOnceHostAnswered,
  routeNewTabLaunch,
  type AgentTabLaunchOutcome
} from '@/lib/launch-agent-in-new-tab-host-agents'

export type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab-args'

export { shouldQueueTerminalFocusAfterMenuClose } from '@/lib/launch-agent-in-new-tab-host-agents'

/**
 * Create a new terminal tab and queue the agent's launch command, optionally
 * with an initial prompt.
 *
 * Submission mode follows `promptInjectionMode`: argv/flag agents fold the
 * prompt into the launch command; followup-path agents launch empty and get a
 * post-ready draft paste. Callers can override via `promptDelivery`.
 *
 * Returns `null` for cancellation; preparation failures return a notified refusal.
 */
export function launchAgentInNewTabWithOutcome(
  args: LaunchAgentInNewTabArgs
): AgentTabLaunchOutcome {
  const {
    agent,
    worktreeId,
    groupId,
    prompt,
    agentArgs,
    sessionOptions,
    initialCwd,
    promptDelivery = 'auto-submit',
    launchSource,
    quickCommandLabel,
    launchPlatform,
    onPromptDelivered,
    onPromptDeliveryUnconfirmed,
    pendingActivationSpawn,
    beforeSurfaceOpen,
    activate
  } = args
  const store = useAppStore.getState()
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  // Why: a followup-path agent gets its prompt pasted unsubmitted after start, so route it as a draft.
  const routePromptDelivery =
    hasPrompt && isFollowupPath && promptDelivery === 'auto-submit' ? 'draft' : promptDelivery
  // Resolve structured ownership first; only terminal routes plan CLI arguments.
  const route = routeNewTabLaunch(store, args, {
    agent,
    requestedSurface: args.requestedSurface,
    selectedExecutionHostId: args.selectedExecutionHostId,
    workspace: { kind: workspaceKindForWorktreeId(worktreeId), worktreeId },
    prompt: trimmedPrompt,
    promptDelivery: routePromptDelivery,
    tuiCustomization: { cwd: initialCwd },
    ...(sessionOptions ? { launchOptions: sessionOptions } : {}),
    onPromptDelivered,
    ...(args.promptKeptByCaller ? { promptKeptByCaller: true as const } : {})
  })
  if ('awaited' in route) {
    return launchOnceHostAnswered(route, args, (next) => launchAgentInNewTabWithOutcome(next))
  }
  const { plan } = route
  if (plan?.route === 'structured-native-chat') {
    const structured = launchStructuredAgentFromNewTab({
      plan,
      worktreeId,
      ...(args.focusIntent ? { focusIntent: args.focusIntent } : {}),
      ...(groupId ? { groupId } : {}),
      ...(beforeSurfaceOpen ? { beforeSurfaceOpen } : {}),
      ...(args.onStructuredHostDeclined ? { onHostDeclined: args.onStructuredHostDeclined } : {}),
      // The host's "no" opens this same launch as a terminal, with the caller's arguments.
      openTerminal: (terminalPlan, terminalActivate) =>
        launchAgentInNewTabWithOutcome({
          ...args,
          beforeSurfaceOpen: undefined,
          // A terminal opened behind the visible chat leaves its refusal to that chat's notice.
          ...(terminalActivate === false
            ? { prompt: undefined, activate: false, presentsRefusal: true as const }
            : {}),
          requestId: undefined,
          agentSessionLaunchPlan: terminalPlan
        })
    })
    if (!structured) {
      args.focusIntent?.cancel()
      return null
    }
    return structured
  }

  // One owner presents a preparation refusal: a visible surface given its text, else this toast.
  const refuse = (recovery: string, notify: () => void): AgentTabLaunchOutcome => {
    args.focusIntent?.cancel()
    if (!args.presentsRefusal) {
      notify()
    }
    return {
      refused: { delivered: false, failureNotified: true },
      ...(args.presentsRefusal ? { recovery } : {})
    }
  }
  const executionContext = resolveAgentLaunchExecutionContext(store, { worktreeId, launchPlatform })
  if ('unavailable' in executionContext) {
    // A host still connecting is a wait, not a failure: decline like a disabled control, without a
    // message; the caller keeps its prompt and treats the outcome as handled.
    if (executionContext.unavailable.pending) {
      args.focusIntent?.cancel()
      return { refused: { delivered: false, failureNotified: true } }
    }
    const recovery = agentLaunchRecoveryMessage(executionContext.unavailable.recovery)
    return refuse(recovery, () => notifyAgentLaunchFailure(agent, recovery))
  }
  const { resolvedLaunchPlatform, isRemote, queuedShell } = executionContext
  const terminalShell = queuedShell ?? (resolvedLaunchPlatform === 'win32' ? 'powershell' : 'posix')
  const argsProblem = invalidTerminalArgsMessage(agent, agentArgs, terminalShell)
  if (argsProblem) {
    return refuse(argsProblem, () => toast.error(argsProblem))
  }
  const buildStartup = (
    agentLaunchChoices = readAgentLaunchPreferencesForWorktree(store, worktreeId).agentLaunchChoices
  ) =>
    planLaunchAgentStartupPrompt({
      base: resolveAgentStartupPlanInputs({
        agent,
        settings: { ...store.settings, agentLaunchChoices },
        agentArgs,
        sessionOptions,
        sessionOptionsYieldToAgentArgs: args.sessionOptionsYieldToAgentArgs,
        platform: resolvedLaunchPlatform,
        shell: queuedShell,
        isRemote
      }),
      prompt: trimmedPrompt,
      promptDelivery,
      isFollowupPath
    })
  args.focusIntent?.cancel()
  const runtimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(store, worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    if (beforeSurfaceOpen?.({ kind: 'host-published' }) === false) {
      return null
    }
    const webHostDelivery = launchAgentInWebHostTab({
      agent,
      worktreeId,
      environmentId: runtimeEnvironmentId,
      groupId,
      cwd: initialCwd,
      buildStartup,
      sessionOptions,
      prompt: trimmedPrompt,
      promptDelivery,
      agentArgs,
      viewMode: 'terminal',
      ...(activate === false ? { activate } : {}),
      onPromptDelivered
    })
    return {
      surface: { kind: 'host-published' },
      terminalCompletion: webHostDelivery,
      pasteDraftAfterLaunch: false,
      ...(hasPrompt ? { promptDeliveryResult: webHostDelivery } : {})
    }
  }

  const { startupPlan, pasteDraftAfterLaunch, submitPastedPrompt } = buildStartup()
  let promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }> | undefined
  if (!startupPlan) {
    return refuse(agentLaunchCheckSettingsMessage(), () => notifyAgentLaunchFailure(agent))
  }

  if (beforeSurfaceOpen?.({ kind: 'local-terminal' }) === false) {
    return null
  }
  if (
    pasteDraftAfterLaunch !== null &&
    newTabPromptLaunchesThroughHost({ promptDelivery, pastesPrompt: true, isRemote })
  ) {
    const launched = launchNewTabPromptThroughHost({
      agent,
      worktreeId,
      ...(groupId ? { groupId } : {}),
      prompt: trimmedPrompt,
      ...(agentArgs !== undefined ? { agentArgs } : {}),
      ...(sessionOptions ? { sessionOptions } : {}),
      ...(initialCwd?.trim() ? { cwd: initialCwd } : {}),
      launchSource: launchSource ?? 'tab_bar_quick_launch',
      quickCommandLabel,
      ...(activate === false ? { activate: false } : {}),
      ...(pendingActivationSpawn ? { pendingActivationSpawn: true } : {}),
      pasteContent: pasteDraftAfterLaunch,
      submit: submitPastedPrompt,
      ...(onPromptDelivered ? { onPromptDelivered } : {}),
      ...(onPromptDeliveryUnconfirmed ? { onPromptDeliveryUnconfirmed } : {})
    })
    return {
      surface: { kind: 'local-terminal', tabId: launched.tabId },
      startupPlan,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: launched.promptDeliveryResult
    }
  }
  const tab = store.createTab(worktreeId, groupId, undefined, {
    launchAgent: agent,
    quickCommandLabel,
    ...(pendingActivationSpawn ? { pendingActivationSpawn: true } : {}),
    ...(activate === false ? { activate: false } : {}),
    pendingStartup: {
      command: startupPlan.launchCommand,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      launchConfig: startupPlan.launchConfig,
      launchAgent: agent,
      ...(agentArgs !== undefined ? { agentArgsOverride: agentArgs } : {}),
      ...(startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
        : {}),
      ...(agent === 'command-code' && hasPrompt && promptDelivery === 'auto-submit'
        ? { initialAgentStatus: { agent, prompt: trimmedPrompt } }
        : {}),
      telemetry: {
        agent_kind: tuiAgentToAgentKind(agent),
        launch_source: launchSource ?? 'tab_bar_quick_launch',
        request_kind: 'new'
      }
    }
  })
  if (initialCwd?.trim()) {
    // Why: queue before mount so local, WSL, and SSH continuations preserve their subdirectory.
    store.queueTabInitialCwd(tab.id, initialCwd)
  }
  // Safe for native-prefill agents: delivery skips paste when their draft already arrived at launch.
  if (hasPrompt && promptDelivery === 'draft' && pasteDraftAfterLaunch === null) {
    // Native argv prefill skips the paste callback, so seed the chat composer here.
    seedNativeChatLaunchDraftForAgentTab({ tabId: tab.id, agent, text: trimmedPrompt })
  }
  if (pasteDraftAfterLaunch !== null) {
    const deliveryPromise = pasteAgentLaunchPromptOnceReady({
      worktreeId,
      tabId: tab.id,
      agent,
      content: pasteDraftAfterLaunch,
      submit: submitPastedPrompt,
      prompt: trimmedPrompt,
      ...(onPromptDelivered ? { onPromptDelivered } : {}),
      ...(onPromptDeliveryUnconfirmed ? { onPromptDeliveryUnconfirmed } : {})
    })
    promptDeliveryResult = deliveryPromise
    void deliveryPromise.catch((error) =>
      console.error('Prompt delivery failed after launch', error)
    )
  } else if (hasPrompt) {
    onPromptDelivered?.()
  }

  // Reveal Terminal within the launch workspace; otherwise an editor can hide it, while floating launches must leave main selection alone.
  if (activate !== false) {
    store.setActiveTabType('terminal', worktreeId)
  }

  // Persist tab order or terminals-first reconciliation would jump the new tab to index 0.
  persistAgentLaunchTabOrder(worktreeId, tab.id)

  return {
    surface: { kind: 'local-terminal', tabId: tab.id },
    startupPlan,
    pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
    ...(promptDeliveryResult ? { promptDeliveryResult } : {})
  }
}

export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): AgentTabLaunchOutcome {
  return launchAgentInNewTabWithOutcome(args)
}
