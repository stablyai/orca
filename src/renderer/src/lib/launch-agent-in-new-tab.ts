import { readLaunchPermissionChoice } from '../../../shared/tui-agent-permission-choice'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab-args'
import { useAppStore } from '@/store'
import { validateActionTerminalArgs } from './launch-work-item-direct-messages'
import { planLaunchAgentStartupPrompt } from '@/lib/launch-agent-startup-prompt-plan'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { pasteAgentLaunchPromptOnceReady } from '@/lib/launch-agent-tab-prompt-paste'
import {
  launchNewTabPromptThroughHost,
  newTabPromptLaunchesThroughHost
} from '@/lib/launch-agent-new-tab-host-route'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { launchAgentInWebHostTab } from '@/lib/launch-agent-web-host-tab'
import {
  agentLaunchPermissionSettings,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { terminalSessionOptionInputs } from '../../../shared/tui-agent-launch-command'
import { resolveAgentLaunchExecutionContext } from '@/lib/launch-agent-execution-context'
import { launchStructuredAgentFromNewTab } from '@/lib/launch-agent-in-new-tab-structured-route'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import {
  launchOnceHostAnswered,
  routeNewTabLaunch,
  type AgentTabLaunchOutcome,
  type LaunchAgentInNewTabResult
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
 * Returns `null` when no startup plan can be built (e.g. a whitespace-only prompt).
 */
export function launchAgentInNewTabWithOutcome(
  args: LaunchAgentInNewTabArgs,
  notifyFailure = true
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
  const executionContext = resolveAgentLaunchExecutionContext(store, { worktreeId, launchPlatform })
  if (!executionContext) {
    args.focusIntent?.cancel()
    return null
  }
  const { resolvedLaunchPlatform, isRemote, queuedShell } = executionContext
  const permissionSettings = agentLaunchPermissionSettings(
    agent,
    store.settings ?? {},
    sessionOptions
  )
  const effectiveAgentArgs =
    agentArgs !== undefined
      ? agentArgs
      : resolveTuiAgentLaunchArgs(
          agent,
          permissionSettings,
          readLaunchPermissionChoice(sessionOptions) ? 'own' : undefined
        )
  const agentEnv = resolveTuiAgentLaunchEnv(agent, permissionSettings, resolvedLaunchPlatform)
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
          ...(terminalActivate === false ? { prompt: undefined, activate: false } : {}),
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

  const terminalShell = queuedShell ?? (resolvedLaunchPlatform === 'win32' ? 'powershell' : 'posix')
  if (!validateActionTerminalArgs(agent, agentArgs, terminalShell, notifyFailure)) {
    args.focusIntent?.cancel()
    return { refused: { delivered: false, failureNotified: notifyFailure } }
  }
  // The saved choice becomes flags that replace conflicting raw ones, unless it yields to them.
  const terminalOptions = terminalSessionOptionInputs({
    agent,
    sessionOptions,
    yieldToAgentArgs: args.sessionOptionsYieldToAgentArgs,
    agentArgs: effectiveAgentArgs,
    shell: terminalShell
  })
  const startupPlanBase = {
    agent,
    cmdOverrides: store.settings?.agentCmdOverrides ?? {},
    platform: resolvedLaunchPlatform,
    shell: queuedShell,
    isRemote,
    agentArgs: effectiveAgentArgs,
    agentEnv,
    ...terminalOptions
  }
  const { startupPlan, pasteDraftAfterLaunch, submitPastedPrompt } = planLaunchAgentStartupPrompt({
    base: startupPlanBase,
    prompt: trimmedPrompt,
    promptDelivery,
    isFollowupPath
  })
  let promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }> | undefined

  if (!startupPlan) {
    args.focusIntent?.cancel()
    return null
  }

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
      startupPlan,
      prompt: trimmedPrompt,
      promptDelivery,
      pastePromptAfterReady: pasteDraftAfterLaunch,
      submitPastedPrompt,
      agentArgs,
      // Send the resolved terminal choice explicitly or a paired host could substitute its own chat default.
      viewMode: 'terminal',
      ...(activate === false ? { activate } : {}),
      onPromptDelivered
    })
    return {
      surface: { kind: 'host-published' },
      terminalCompletion: webHostDelivery,
      startupPlan,
      pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
      ...(pasteDraftAfterLaunch !== null && promptDelivery === 'submit-after-ready'
        ? { promptDeliveryResult: webHostDelivery }
        : {})
    }
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
      ...(terminalOptions.sessionOptions ? { sessionOptions: terminalOptions.sessionOptions } : {}),
      ...(initialCwd?.trim() ? { cwd: initialCwd } : {}),
      launchSource: launchSource ?? 'tab_bar_quick_launch',
      quickCommandLabel,
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
    if (promptDelivery === 'submit-after-ready') {
      promptDeliveryResult = deliveryPromise
    } else {
      void deliveryPromise.catch((error) =>
        console.error('Prompt delivery failed after launch', error)
      )
    }
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

export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  const result = launchAgentInNewTabWithOutcome(args, false)
  return result && 'refused' in result ? null : result
}
