import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { launchAgentInWebHostTab } from '@/lib/launch-agent-web-host-tab'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { seedCommandCodeSubmittedPromptStatus } from '@/lib/command-code-prompt-status-seed'
import type { TuiAgent } from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { resolveNativeChatSessionOptionDefaults } from '../../../shared/native-chat-session-option-defaults'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'

export type LaunchAgentInNewTabArgs = {
  agent: TuiAgent
  worktreeId: string
  /** Tab group the user launched from; keeps split-group launches in that pane instead of the active group. */
  groupId?: string
  /** Optional initial prompt; delivery depends on `promptDelivery` and the agent's prompt mode. */
  prompt?: string
  /** Optional CLI arguments appended to the selected agent command. */
  agentArgs?: string | null
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
}

export type LaunchAgentInNewTabResult = {
  tabId: string | null
  startupPlan: AgentStartupPlan
  pasteDraftAfterLaunch: boolean
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
} | null

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
export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  const {
    agent,
    worktreeId,
    groupId,
    prompt,
    agentArgs,
    promptDelivery = 'auto-submit',
    launchSource,
    quickCommandLabel,
    launchPlatform,
    onPromptDelivered
  } = args
  const store = useAppStore.getState()
  const worktree = store.allWorktrees?.().find((entry: { id: string }) => entry.id === worktreeId)
  const repo = worktree ? store.repos?.find((entry) => entry.id === worktree.repoId) : null
  const resolvedLaunchPlatform =
    launchPlatform ??
    (repo
      ? getAgentLaunchPlatformForRepo(
          repo,
          repo.connectionId ? undefined : getLocalProjectExecutionRuntimeContext(store, worktreeId)
        )
      : CLIENT_PLATFORM)
  // Why: SSH remotes deploy the shim as plain `orca`, so skip the Linux-only `orca-ide` rename for remote launches.
  const isRemote = repo ? repoIsRemote(repo) : false
  const queuedShell = resolveLocalWindowsAgentStartupShell({
    platform: resolvedLaunchPlatform,
    isRemote,
    terminalWindowsShell: store.settings?.terminalWindowsShell
  })
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  const effectiveAgentArgs =
    agentArgs !== undefined
      ? agentArgs
      : resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs)
  const agentEnv = resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv)
  const startupPlanBase = {
    agent,
    cmdOverrides,
    platform: resolvedLaunchPlatform,
    shell: queuedShell,
    isRemote,
    agentArgs: effectiveAgentArgs,
    agentEnv,
    sessionOptions: resolveNativeChatSessionOptionDefaults(
      store.settings?.nativeChatSessionOptions,
      agent
    )
  }
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  // argv/flag agents fold the prompt into the launch command; followup/generated launches deliver it via post-launch paste.
  let startupPlan: AgentStartupPlan | null = null
  let pasteDraftAfterLaunch: string | null = null
  let submitPastedPrompt = false
  let forcePasteAfterLaunch = false
  let promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }> | undefined

  if (hasPrompt && promptDelivery === 'submit-after-ready') {
    // Why: multi-line generated prompts are too large for a shell argv, so launch clean then paste+submit in the TUI.
    startupPlan = buildAgentStartupPlan({
      ...startupPlanBase,
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = trimmedPrompt
    submitPastedPrompt = true
    forcePasteAfterLaunch = true
  } else if (hasPrompt && promptDelivery === 'draft') {
    const draftLaunchPlan = buildAgentDraftLaunchPlan({
      ...startupPlanBase,
      draft: trimmedPrompt
    })
    if (draftLaunchPlan) {
      startupPlan = {
        agent: draftLaunchPlan.agent,
        launchCommand: draftLaunchPlan.launchCommand,
        expectedProcess: draftLaunchPlan.expectedProcess,
        followupPrompt: null,
        launchConfig: draftLaunchPlan.launchConfig,
        ...(draftLaunchPlan.sessionOptions
          ? { sessionOptions: draftLaunchPlan.sessionOptions }
          : {}),
        ...(draftLaunchPlan.startupCommandDelivery
          ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
          : {}),
        ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
      }
    } else {
      startupPlan = buildAgentStartupPlan({
        ...startupPlanBase,
        prompt: '',
        allowEmptyPromptLaunch: true
      })
      pasteDraftAfterLaunch = trimmedPrompt
    }
  } else if (hasPrompt && isFollowupPath) {
    startupPlan = buildAgentStartupPlan({
      ...startupPlanBase,
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = trimmedPrompt
  } else {
    startupPlan = buildAgentStartupPlan({
      ...startupPlanBase,
      prompt: hasPrompt ? trimmedPrompt : '',
      allowEmptyPromptLaunch: !hasPrompt
    })
  }

  if (!startupPlan) {
    return null
  }

  // Why: the remote host can't infer this client's draft/default view choice, so decide it here for paired tabs too.
  const viewModePromptDelivery =
    hasPrompt && isFollowupPath && promptDelivery === 'auto-submit' ? 'draft' : promptDelivery
  const initialViewModeProps = initialAgentTabViewModeProps(store.settings, {
    agent,
    promptDelivery: viewModePromptDelivery,
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
      getConnectionIdFromState(store, worktreeId)
    )
  })

  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId) && pasteDraftAfterLaunch === null) {
    launchAgentInWebHostTab({
      agent,
      worktreeId,
      environmentId: runtimeEnvironmentId,
      groupId,
      hasPrompt,
      startupPlan,
      // Why: send the client's resolved terminal choice explicitly, else a paired host applies its own default.
      viewMode: initialViewModeProps.viewMode ?? 'terminal',
      onPromptDelivered
    })
    return { tabId: null, startupPlan, pasteDraftAfterLaunch: false }
  }

  // Why: queue startup BEFORE TerminalPane mounts — it snapshots pendingStartupByTabId in useState on first render.
  // Why: followup path pastes an unsubmitted draft, so gate the initial chat view like a draft launch, not auto-submit.
  const tab = store.createTab(worktreeId, groupId, undefined, {
    launchAgent: agent,
    quickCommandLabel,
    ...initialViewModeProps
  })
  seedNativeChatAppliedSessionOptions(tab.id, agent, startupPlan.sessionOptions)
  store.queueTabStartupCommand(tab.id, {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
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
  if (pasteDraftAfterLaunch !== null) {
    // Why: onTimeout surfaces silent paste failures — a stalled readiness wait would otherwise drop notes silently.
    let failureNotified = false
    const deliveryPromise = deliverLaunchPromptToAgentTab({
      tabId: tab.id,
      content: pasteDraftAfterLaunch,
      agent,
      submit: submitPastedPrompt,
      forcePaste: forcePasteAfterLaunch,
      onTimeout: () => {
        const state = useAppStore.getState()
        const tabsForWorktree = state.tabsByWorktree[worktreeId] ?? []
        const currentTab = tabsForWorktree.find((t) => t.id === tab.id)
        if (currentTab?.ptyId === null) {
          // Why: PTY never spawned = genuine launch failure; stay silent so the caller emits the sole notice.
          return
        }
        if (!currentTab || state.activeWorktreeId !== worktreeId) {
          // Why: user cancelled (closed tab / switched worktrees); mark notified so the deferred caller suppresses its toast too.
          failureNotified = true
          return
        }
        toast.message(
          translate(
            'auto.lib.launch.agent.in.new.tab.a5a1f7033f',
            "Your {{value0}} wasn't sent — paste it once the agent is ready.",
            { value0: submitPastedPrompt ? 'prompt' : 'notes' }
          )
        )
        failureNotified = true
        track('agent_error', {
          error_class: 'paste_readiness_timeout',
          agent_kind: tuiAgentToAgentKind(agent)
        })
      }
    }).then((delivered) => {
      if (delivered) {
        if (agent === 'command-code' && submitPastedPrompt) {
          // Why: Command Code has no prompt-submit hook; when Orca submits a
          // generated prompt after readiness, seed working at delivery time.
          seedCommandCodeSubmittedPromptStatus(worktreeId, tab.id, trimmedPrompt)
        }
        onPromptDelivered?.()
      }
      return { delivered, failureNotified: !delivered && failureNotified }
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

  // Why: without setActiveTabType('terminal') a worktree showing an editor keeps rendering it and the new tab stays hidden.
  store.setActiveTabType('terminal')

  // Why: persist tab-bar order so reconcileTabOrder doesn't fall back to terminals-first and jump the new tab to index 0.
  const fresh = useAppStore.getState()
  const termIds = (fresh.tabsByWorktree[worktreeId] ?? []).map((t) => t.id)
  const editorIds = fresh.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
  const browserIds = (fresh.browserTabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
  const base = reconcileTabOrder(
    fresh.tabBarOrderByWorktree[worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tab.id)
  order.push(tab.id)
  fresh.setTabBarOrder(worktreeId, order)

  return {
    tabId: tab.id,
    startupPlan,
    pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
    ...(promptDeliveryResult ? { promptDeliveryResult } : {})
  }
}
