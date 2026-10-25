import type {
  AgentSessionLaunchPlan,
  AgentSessionLaunchRequest
} from '@/lib/agent-session-launch-plan'
import { useAppStore } from '@/store'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
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
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { resolveAgentLaunchExecutionContext } from '@/lib/launch-agent-execution-context'
import { launchStructuredAgentFromNewTab } from '@/lib/launch-agent-in-new-tab-structured-route'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { StructuredLaunchTerminal } from '@/lib/structured-agent-session-launch-admission'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import {
  launchOnceHostAnswered,
  routeNewTabLaunch
} from '@/lib/launch-agent-in-new-tab-host-agents'
import type { AgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import type { NativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'

/** Mint per user action or preserve the request ID already carried by the caller’s plan. */
type LaunchAgentInNewTabRequest =
  | { requestId: AgentLaunchRequestId; agentSessionLaunchPlan?: undefined }
  | {
      /** Keeps a preflighted route authoritative across workspace creation. */
      agentSessionLaunchPlan: AgentSessionLaunchPlan
      requestId?: undefined
    }

export type LaunchAgentInNewTabArgs = LaunchAgentInNewTabRequest & {
  requestedSurface?: AgentSessionLaunchRequest['requestedSurface']
  selectedExecutionHostId?: AgentSessionLaunchRequest['selectedExecutionHostId']
  agent: TuiAgent
  worktreeId: string
  /** Captured at a new-chat action before the host can delay route selection. */
  focusIntent?: NativeChatComposerFocusIntent
  /** Tab group the user launched from; keeps split-group launches in that pane instead of the active group. */
  groupId?: string
  /** Optional initial prompt; delivery depends on `promptDelivery` and the agent's prompt mode. */
  prompt?: string
  /** Optional CLI arguments appended to the selected agent command. */
  agentArgs?: string | null
  initialCwd?: string | null
  /** How to deliver the prompt: `draft` leaves it editable, `submit-after-ready` sends it once the TUI is ready. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Telemetry surface that initiated this launch. Defaults to the tab-bar quick-launch entry point. */
  launchSource?: LaunchSource
  /** User-authored Quick Command label for local tabs created from the tab bar. */
  quickCommandLabel?: string | null
  /** Shell platform for the startup command; defaults to renderer OS. SSH/WSL worktrees run Linux even from Windows. */
  launchPlatform?: NodeJS.Platform
  /** Called after the prompt is actually delivered to the agent input path. */
  onPromptDelivered?: () => void
  /** The caller keeps the prompt's text if it does not go out (notes), so no composer gets it. */
  promptKeptByCaller?: true
  /** Report blind PTY writes before onPromptDelivered so terminal launches cannot claim observed composer delivery. */
  onPromptDeliveryUnconfirmed?: () => void
  /** Keep terminal launches in a floating workspace from taking global selection. */
  activate?: boolean
  /** The launch seeds a workspace being opened, so its PTY spawn must not reshuffle Recent. */
  pendingActivationSpawn?: boolean
  /** Lets a workspace reveal itself before the selected surface opens. */
  beforeSurfaceOpen?: (
    surface: { kind: 'local-terminal' } | { kind: 'host-published' }
  ) => boolean | void
  /** Opens instead of this agent's terminal when the host declines its structured chat. */
  onStructuredHostDeclined?: () => StructuredLaunchTerminal
}

/** `host-published`: the surface opens once its host answers; `local-chat` opened before it did. */
export type AgentLaunchSurface =
  | { kind: 'local-terminal'; tabId: string }
  | { kind: 'local-chat'; tabId: string }
  | { kind: 'host-published' }

export type LaunchAgentInNewTabResult = {
  surface: AgentLaunchSurface
  startupPlan: AgentStartupPlan
  pasteDraftAfterLaunch: boolean
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
  /** Structured route only: what the launch did once it settled. The call stays synchronous. */
  terminalCompletion?: StructuredLaunchTerminal['completion']
  structuredSettlement?: Promise<StructuredAgentLaunchSettlement>
} | null

export function shouldQueueTerminalFocusAfterMenuClose(
  result: NonNullable<LaunchAgentInNewTabResult>
): boolean {
  return result.surface.kind === 'host-published'
}

/** Create the routed agent surface with optional prompt; terminal argv agents embed text and follow-up agents paste after readiness unless promptDelivery overrides. Return null when planning fails. */
function launchAgentInNewTabInternal(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  const {
    agent,
    worktreeId,
    groupId,
    prompt,
    agentArgs,
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
  const effectiveAgentArgs =
    agentArgs !== undefined ? agentArgs : resolveTuiAgentLaunchArgs(agent, store.settings)
  const agentEnv = resolveTuiAgentLaunchEnv(agent, store.settings, resolvedLaunchPlatform)
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  // Why: a followup-path agent gets its prompt pasted unsubmitted after start, so route it as a draft.
  const routePromptDelivery =
    hasPrompt && isFollowupPath && promptDelivery === 'auto-submit' ? 'draft' : promptDelivery
  const startupPlanBase = {
    agent,
    cmdOverrides: store.settings?.agentCmdOverrides ?? {},
    platform: resolvedLaunchPlatform,
    shell: queuedShell,
    isRemote,
    agentArgs: effectiveAgentArgs,
    agentEnv
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

  // Resolve structured ownership first, including paired hosts; only terminal routes fall through to host-published PTYs.
  const route = routeNewTabLaunch(store, args, {
    agent,
    requestedSurface: args.requestedSurface,
    selectedExecutionHostId: args.selectedExecutionHostId,
    workspace: { kind: workspaceKindForWorktreeId(worktreeId), worktreeId },
    prompt: trimmedPrompt,
    promptDelivery: routePromptDelivery,
    tuiCustomization: { cwd: initialCwd },
    onPromptDelivered,
    ...(args.promptKeptByCaller ? { promptKeptByCaller: true as const } : {})
  })
  if ('awaited' in route) {
    return launchOnceHostAnswered(route, args, startupPlan, launchAgentInNewTabInternal)
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
        launchAgentInNewTabInternal({
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
    return { ...structured, startupPlan }
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

export { launchAgentInNewTabInternal as launchAgentInNewTab }
