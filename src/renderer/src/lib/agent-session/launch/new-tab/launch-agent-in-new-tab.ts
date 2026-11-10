import { refuseAgentTabLaunch, refuseUnavailableAgentTabLaunch } from './launch-agent-tab-refusal'
import {
  launchNewTabPromptThroughHost,
  newTabPromptLaunchesThroughHost
} from '@/lib/agent-session/launch/new-tab/launch-agent-new-tab-host-route'
import type { LaunchAgentInNewTabArgs } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-args'
import { useAppStore } from '@/store/index'
import { toast } from 'sonner'
import { invalidTerminalArgsMessage } from '../../../workspace/creation/work-item/launch-work-item-direct-messages'
import {
  agentLaunchCheckSettingsMessage,
  notifyAgentLaunchFailure
} from '@/lib/agent-session/launch/failure/agent-launch-failure'
import { planLaunchAgentStartupPrompt } from '@/lib/agent-session/launch/prompt/launch-agent-startup-prompt-plan'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
import '@/lib/telemetry'
import { tuiAgentToAgentKind } from '../../../../../../shared/agent-kind'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-session/launch/prompt/agent-launch-prompt-delivery'
import { pasteAgentLaunchPromptOnceReady } from '@/lib/agent-session/launch/prompt/launch-agent-tab-prompt-paste'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { snapshotAgentTabLaunchArgs } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-args'
import { isWebRuntimeSessionActive } from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import { launchAgentInWebHostTab } from '@/lib/agent-session/launch/new-tab/launch-agent-web-host-tab'
import { resolveAgentStartupPlanInputs } from '../../../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { readAgentLaunchPreferencesForWorktree } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import { TUI_AGENT_CONFIG } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  agentTabLaunchStore,
  resolveAgentLaunchExecutionContext
} from '@/lib/agent-session/launch/new-tab/launch-agent-execution-context'
import { launchStructuredAgentFromNewTab } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-structured-route'
import '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { workspaceKindForWorktreeId } from '../../../../../../shared/agent-launch/contracts/workspace-launch-kind'
import { launchOnceHostAnswered, routeNewTabLaunch } from './launch-agent-in-new-tab-host-agents'
import type { AgentTabLaunchOutcome } from './launch-agent-in-new-tab-host-agents'

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
  args: LaunchAgentInNewTabArgs,
  notifyFailure = true
): AgentTabLaunchOutcome {
  const notify = () => notifyAgentLaunchFailure(args.agent)
  try {
    return openAgentInNewTab(args, notifyFailure, notify)
  } catch {
    return refuseAgentTabLaunch(args, agentLaunchCheckSettingsMessage(), notify, notifyFailure)
  }
}

function openAgentInNewTab(
  args: LaunchAgentInNewTabArgs,
  notifyFailure: boolean,
  notify: () => void
): AgentTabLaunchOutcome {
  args = snapshotAgentTabLaunchArgs(args)
  const {
    agent,
    worktreeId,
    groupId,
    prompt,
    agentArgs,
    sessionOptions,
    initialCwd,
    trustWorktreeId,
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
  const store = agentTabLaunchStore(useAppStore.getState(), args)
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
    preferredSurface: args.preferredSurface,
    selectedExecutionHostId: args.selectedExecutionHostId,
    workspace: { kind: workspaceKindForWorktreeId(worktreeId), worktreeId },
    prompt: trimmedPrompt,
    promptDelivery: routePromptDelivery,
    tuiCustomization: { cwd: initialCwd },
    ...(sessionOptions ? { launchOptions: sessionOptions } : {}),
    ...(args.chatSessionOptions !== undefined
      ? { chatLaunchOptions: args.chatSessionOptions }
      : {}),
    onPromptDelivered,
    ...(args.promptKeptByCaller ? { promptKeptByCaller: true as const } : {})
  })
  if ('awaited' in route) {
    return launchOnceHostAnswered(
      route,
      args,
      (next) => launchAgentInNewTabWithOutcome(next, notifyFailure),
      notifyFailure && !args.presentsRefusal ? notify : undefined
    )
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
        launchAgentInNewTabWithOutcome(
          {
            ...args,
            beforeSurfaceOpen: undefined,
            // A terminal opened behind the visible chat leaves its refusal to that chat's notice.
            ...(terminalActivate === false
              ? { prompt: undefined, activate: false, presentsRefusal: true as const }
              : {}),
            requestId: undefined,
            agentSessionLaunchPlan: terminalPlan
          },
          notifyFailure
        )
    })
    if (!structured) {
      args.focusIntent?.cancel()
      return null
    }
    return structured
  }

  const executionContext = resolveAgentLaunchExecutionContext(store, {
    worktreeId,
    launchPlatform,
    workspaceExecutionHostId: args.workspaceExecutionHostId
  })
  if ('unavailable' in executionContext) {
    return refuseUnavailableAgentTabLaunch(args, executionContext.unavailable, notifyFailure)
  }
  const { resolvedLaunchPlatform, isRemote, queuedShell } = executionContext
  const terminalShell = queuedShell ?? (resolvedLaunchPlatform === 'win32' ? 'powershell' : 'posix')
  const argsProblem = invalidTerminalArgsMessage(agent, agentArgs, terminalShell)
  if (argsProblem) {
    return refuseAgentTabLaunch(args, argsProblem, () => toast.error(argsProblem), notifyFailure)
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
      workspaceExecutionHostId: args.workspaceExecutionHostId,
      groupId,
      cwd: initialCwd,
      ...(trustWorktreeId ? { trustWorktreeId } : {}),
      buildStartup,
      sessionOptions,
      prompt: trimmedPrompt,
      promptDelivery,
      agentArgs: args.actionAgentArgs === undefined ? agentArgs : undefined,
      actionAgentArgs: args.actionAgentArgs,
      launchPlatform: resolvedLaunchPlatform,
      launchShell: queuedShell,
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
    return refuseAgentTabLaunch(args, agentLaunchCheckSettingsMessage(), notify, notifyFailure)
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
      ...(trustWorktreeId ? { trustWorktreeId } : {}),
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
    ...(initialCwd?.trim() ? { startupCwd: initialCwd } : {}),
    ...(pendingActivationSpawn ? { pendingActivationSpawn: true } : {}),
    ...(activate === false ? { activate: false } : {}),
    pendingStartup: {
      ...(trustWorktreeId ? { trustWorktreeId } : {}),
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

export const launchAgentInNewTab = launchAgentInNewTabWithOutcome
