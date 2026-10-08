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
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { launchAgentInWebHostTab } from '@/lib/launch-agent-web-host-tab'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { resolveAgentLaunchExecutionContext } from '@/lib/launch-agent-execution-context'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { launchStructuredAgentFromNewTab } from '@/lib/launch-agent-in-new-tab-structured-route'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { StructuredLaunchTerminal } from '@/lib/structured-agent-session-launch-admission'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import { relaunchWithClaudeAccount, stampClaudeLaunchAccount } from '@/lib/claude-launch-account'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import {
  launchOnceHostAnswered,
  routeNewTabLaunch
} from '@/lib/launch-agent-in-new-tab-host-agents'
import type { AgentLaunchRequestId } from '@/lib/agent-launch-request-id'

/** The user action this launch serves: minted where that action is handled, or carried by the
 *  route the caller already planned for it. */
type LaunchAgentInNewTabRequest =
  | { requestId: AgentLaunchRequestId; agentSessionLaunchPlan?: undefined }
  | {
      /** Keeps a preflighted route authoritative across workspace creation. */
      agentSessionLaunchPlan: AgentSessionLaunchPlan
      requestId?: undefined
    }

export type LaunchAgentInNewTabArgs = LaunchAgentInNewTabRequest & {
  agent: TuiAgent
  worktreeId: string
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
  /**
   * Called before `onPromptDelivered` when the paste was written without ever observing the
   * agent's composer, so the launch cannot claim the prompt arrived. Fires only on the
   * terminal route, whose readiness signal the client watches itself.
   */
  onPromptDeliveryUnconfirmed?: () => void
  /** A one-time Claude account choice; the project's saved account applies when omitted. */
  claudeAccountId?: string
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

/** `host-published`: the surface opens once its host answers, a structured chat's included. */
export type AgentLaunchSurface =
  | { kind: 'local-terminal'; tabId: string }
  | { kind: 'host-published' }

export type LaunchAgentInNewTabResult = {
  surface: AgentLaunchSurface
  startupPlan: AgentStartupPlan
  pasteDraftAfterLaunch: boolean
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
  /** Structured route only: what the launch did once it settled. The call stays synchronous. */
  structuredSettlement?: Promise<StructuredAgentLaunchSettlement>
} | null

export { shouldQueueTerminalFocusAfterMenuClose } from '@/lib/launch-agent-in-new-tab-focus'

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
  const { worktreeSshConnectionId, resolvedLaunchPlatform, isRemote, queuedShell } =
    resolveAgentLaunchExecutionContext(store, {
      worktreeId,
      ...(launchPlatform ? { launchPlatform } : {})
    })
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  const effectiveAgentArgs =
    agentArgs !== undefined
      ? agentArgs
      : resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs)
  const agentEnv = resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv)
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  const workspaceKind = workspaceKindForWorktreeId(worktreeId)
  // Why: the remote host can't infer this client's draft/default view choice, so decide it here for paired tabs too.
  const viewModePromptDelivery =
    hasPrompt && isFollowupPath && promptDelivery === 'auto-submit' ? 'draft' : promptDelivery
  const initialViewModeOptions = {
    agent,
    promptDelivery: viewModePromptDelivery,
    launchDraftText: trimmedPrompt,
    nativeChatTranscriptIsLocalReadable:
      isNativeChatTranscriptLocalReadable(worktreeSshConnectionId)
  }
  const initialViewModeProps = initialAgentTabViewModeProps(store.settings, initialViewModeOptions)
  const startupPlanBase = {
    agent,
    cmdOverrides,
    platform: resolvedLaunchPlatform,
    shell: queuedShell,
    isRemote,
    agentArgs: effectiveAgentArgs,
    agentEnv,
    sessionOptions: resolveInitialNativeChatSessionOptions(store.settings, initialViewModeOptions)
  }
  const { startupPlan, pasteDraftAfterLaunch, submitPastedPrompt } = planLaunchAgentStartupPrompt({
    base: startupPlanBase,
    prompt: trimmedPrompt,
    promptDelivery,
    isFollowupPath
  })
  let promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }> | undefined

  if (!startupPlan) {
    return null
  }

  const launchConfig = stampClaudeLaunchAccount(store, args, startupPlan.launchConfig)
  // Why first: a structured chat is created on whichever runtime owns the workspace, a paired
  // server included, so only a non-structured route falls through to the host-published terminal.
  const route = routeNewTabLaunch(store, args, {
    agent,
    workspace: { kind: workspaceKind, worktreeId },
    prompt: trimmedPrompt,
    promptDelivery: viewModePromptDelivery,
    tuiCustomization: { cwd: initialCwd },
    initialSessionOptions: startupPlan.sessionOptions,
    onPromptDelivered,
    ...(args.claudeAccountId ? { claudeAccountId: args.claudeAccountId } : {}),
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
      ...(groupId ? { groupId } : {}),
      ...(beforeSurfaceOpen ? { beforeSurfaceOpen } : {}),
      ...(args.onStructuredHostDeclined ? { onHostDeclined: args.onStructuredHostDeclined } : {}),
      // The host's "no" opens this same launch as a terminal, with the caller's arguments.
      openTerminal: (terminalPlan) =>
        launchAgentInNewTabInternal({
          ...args,
          beforeSurfaceOpen: undefined,
          requestId: undefined,
          agentSessionLaunchPlan: terminalPlan
        })
    })
    return structured && { ...structured, startupPlan }
  }

  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, worktreeId)
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
      startupPlan: { ...startupPlan, launchConfig },
      prompt: trimmedPrompt,
      promptDelivery,
      pastePromptAfterReady: pasteDraftAfterLaunch,
      submitPastedPrompt,
      agentArgs,
      // Why: omission means terminal locally, but would let a paired host apply
      // its own default; send the client's resolved terminal choice explicitly.
      viewMode: initialViewModeProps.viewMode ?? 'terminal',
      onPromptDelivered,
      relaunch: relaunchWithClaudeAccount(launchAgentInNewTab, args)
    })
    return {
      surface: { kind: 'host-published' },
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
    newTabPromptLaunchesThroughHost({ promptDelivery, pastesPrompt: true })
  ) {
    const launched = launchNewTabPromptThroughHost({
      agent,
      worktreeId,
      ...(groupId ? { groupId } : {}),
      prompt: trimmedPrompt,
      ...(agentArgs !== undefined ? { agentArgs } : {}),
      ...(initialCwd?.trim() ? { cwd: initialCwd } : {}),
      ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
      // The same source main's window stamps on its own launches.
      launchSource: launchSource ?? 'tab_bar_quick_launch',
      quickCommandLabel,
      ...(pendingActivationSpawn ? { pendingActivationSpawn: true } : {}),
      ...(initialViewModeProps.viewMode ? { viewMode: initialViewModeProps.viewMode } : {}),
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
  // Why: queue startup BEFORE TerminalPane mounts — it snapshots pendingStartupByTabId in useState on first render.
  // Why: followup path pastes an unsubmitted draft, so gate the initial chat view like a draft launch, not auto-submit.
  const tab = store.createTab(worktreeId, groupId, undefined, {
    launchAgent: agent,
    quickCommandLabel,
    ...(pendingActivationSpawn ? { pendingActivationSpawn: true } : {}),
    ...(activate === false ? { activate: false } : {}),
    ...initialViewModeProps
  })
  seedNativeChatAppliedSessionOptions(tab.id, agent, startupPlan.sessionOptions)
  if (initialCwd?.trim()) {
    // Why: queue before mount so local, WSL, and SSH continuations preserve their subdirectory.
    store.queueTabInitialCwd(tab.id, initialCwd)
  }
  store.queueTabStartupCommand(tab.id, {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig,
    launchAgent: agent,
    ...(agentArgs !== undefined ? { agentArgsOverride: agentArgs } : {}),
    ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
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
  })
  // Why: fire-and-forget the paste-after-ready delivery so callers keep the synchronous { tabId, startupPlan } signature.
  // Why: safe to call unconditionally — the helper short-circuits (no paste) for native-prefill agents already holding the draft.
  if (hasPrompt && promptDelivery === 'draft' && pasteDraftAfterLaunch === null) {
    // Why: the draft rode in on argv (Claude --prefill etc.), so no paste runs
    // and deliverLaunchPromptToAgentTab never seeds. Mirror it into chat here.
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

  // Why: without setActiveTabType('terminal') an activated launch can stay hidden behind an editor.
  // Scoped to the launch's worktree so a floating or background launch leaves the main window's tab alone.
  store.setActiveTabType('terminal', worktreeId)

  // Why: persist tab-bar order so reconcileTabOrder doesn't fall back to terminals-first and jump the new tab to index 0.
  persistAgentLaunchTabOrder(worktreeId, tab.id)

  return {
    surface: { kind: 'local-terminal', tabId: tab.id },
    startupPlan,
    pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
    ...(promptDeliveryResult ? { promptDeliveryResult } : {})
  }
}

export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  return launchAgentInNewTabInternal(args)
}
