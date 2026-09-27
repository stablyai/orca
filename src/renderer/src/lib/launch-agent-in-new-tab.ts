import { useAppStore } from '@/store'
import { planLaunchAgentStartupPrompt } from '@/lib/launch-agent-startup-prompt-plan'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '@/lib/agent-launch-prompt-delivery'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveWorktreeOperationRouteForHost } from '@/lib/worktree-operation-route'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { launchAgentInWebHostTab } from '@/lib/launch-agent-web-host-tab'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { seedCommandCodeSubmittedPromptStatus } from '@/lib/command-code-prompt-status-seed'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { resolveAgentLaunchExecutionContext } from '@/lib/launch-agent-execution-context'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { launchAgentInStructuredNewTab } from '@/lib/launch-agent-in-new-tab-structured'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import type {
  LaunchAgentInNewTabArgs,
  LaunchAgentInNewTabResult
} from './agent-tab-launch-contract'

export type {
  AgentLaunchSurface,
  LaunchAgentInNewTabArgs,
  LaunchAgentInNewTabResult
} from './agent-tab-launch-contract'

export function shouldQueueTerminalFocusAfterMenuClose(
  result: NonNullable<LaunchAgentInNewTabResult>
): boolean {
  return result.surface.kind === 'host-published'
}

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
    executionHostId,
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
    activate = true,
    agentSessionLaunchPlan,
    beforeSurfaceOpen
  } = args
  const store = useAppStore.getState()
  const selectedHost = parseExecutionHostId(executionHostId)
  const { worktreeSshConnectionId, resolvedLaunchPlatform, isRemote, queuedShell } =
    resolveAgentLaunchExecutionContext(store, {
      worktreeId,
      ...(executionHostId ? { executionHostId } : {}),
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
    // A picked host answers for itself; only an unqualified launch asks the workspace.
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
      selectedHost
        ? selectedHost.kind === 'ssh'
          ? selectedHost.targetId
          : null
        : worktreeSshConnectionId
    )
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

  const runtimeEnvironmentId = executionHostId
    ? (resolveWorktreeOperationRouteForHost(store, worktreeId, executionHostId)
        ?.runtimeEnvironmentId ?? null)
    : getRuntimeEnvironmentIdForWorktree(store, worktreeId)
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
      // Why: omission means terminal locally, but would let a paired host apply
      // its own default; send the client's resolved terminal choice explicitly.
      viewMode: initialViewModeProps.viewMode ?? 'terminal',
      activate,
      onPromptDelivered
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

  const plan =
    agentSessionLaunchPlan ??
    planAgentSessionLaunch(store, {
      agent,
      workspace: { kind: workspaceKind, worktreeId, executionHostId },
      prompt: trimmedPrompt,
      promptDelivery: viewModePromptDelivery,
      tuiCustomization: { cwd: initialCwd },
      initialSessionOptions: startupPlan.sessionOptions,
      onPromptDelivered
    })
  if (plan?.route === 'structured-native-chat') {
    const structured = launchAgentInStructuredNewTab({
      plan,
      activate,
      ...(beforeSurfaceOpen
        ? {
            beforeOpen: (sessionId: string) =>
              beforeSurfaceOpen({ kind: 'local-agent-session', sessionId })
          }
        : {}),
      ...(groupId ? { targetGroupId: groupId } : {})
    })
    if (!structured) {
      return null
    }
    return {
      surface: {
        kind: 'local-agent-session',
        tabId: structured.tabId,
        sessionId: structured.sessionId
      },
      startupPlan,
      pasteDraftAfterLaunch: false,
      structuredSettlement: structured.structuredSettlement,
      ...(structured.promptDeliveryResult
        ? { promptDeliveryResult: structured.promptDeliveryResult }
        : {})
    }
  }

  if (beforeSurfaceOpen?.({ kind: 'local-terminal' }) === false) {
    return null
  }
  // Why: queue startup BEFORE TerminalPane mounts — it snapshots pendingStartupByTabId in useState on first render.
  // Why: followup path pastes an unsubmitted draft, so gate the initial chat view like a draft launch, not auto-submit.
  const tab = store.createTab(worktreeId, groupId, undefined, {
    ...(executionHostId ? { executionHostId } : {}),
    // Only when it differs from createTab's own default, so the ordinary launch keeps the
    // exact call shape the tab bar has always made.
    ...(activate ? {} : { activate: false }),
    launchAgent: agent,
    quickCommandLabel,
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
    launchConfig: startupPlan.launchConfig,
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
    const timeoutNotice = createPasteReadinessTimeoutNotice({
      worktreeId,
      tabId: tab.id,
      agent,
      submitted: submitPastedPrompt
    })
    const deliveryPromise = deliverLaunchPromptToAgentTab({
      tabId: tab.id,
      content: pasteDraftAfterLaunch,
      agent,
      submit: submitPastedPrompt,
      forcePaste: true,
      onTimeout: timeoutNotice.onTimeout,
      ...(onPromptDeliveryUnconfirmed ? { onUnconfirmedDelivery: onPromptDeliveryUnconfirmed } : {})
    }).then((delivered) => {
      if (delivered) {
        if (agent === 'command-code' && submitPastedPrompt) {
          // Why: Command Code has no prompt-submit hook; when Orca submits a
          // generated prompt after readiness, seed working at delivery time.
          seedCommandCodeSubmittedPromptStatus(worktreeId, tab.id, trimmedPrompt)
        }
        onPromptDelivered?.()
      }
      return { delivered, failureNotified: !delivered && timeoutNotice.wasNotified() }
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
  // Scoped to the launch's worktree so a floating or background launch leaves the main window's tab alone;
  // gated so a grid launch into the on-screen worktree keeps the editor or browser it was showing.
  if (activate) {
    store.setActiveTabType('terminal', worktreeId)
  }

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
