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
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
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

export type LaunchAgentInNewTabArgs = {
  agent: TuiAgent
  worktreeId: string
  /** The tab group the user clicked from. Keeps split-group launches in the
   *  pane the user initiated from instead of falling through to the active group. */
  groupId?: string
  /** Optional initial prompt. Delivery depends on `promptDelivery` and the
   *  agent's prompt mode. */
  prompt?: string
  /** Optional CLI arguments appended to the selected agent command. */
  agentArgs?: string | null
  /** Force generated prompt text out of the shell launch command. `draft`
   *  leaves it editable; `submit-after-ready` sends it once the TUI is ready. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Telemetry surface that initiated this launch. Defaults to the tab-bar
   *  quick-launch entry point so existing callers stay unchanged. */
  launchSource?: LaunchSource
  /** User-authored Quick Command label for local tabs created from the tab bar. */
  quickCommandLabel?: string | null
  /** Shell platform that will execute the startup command. Defaults to the
   * renderer OS; SSH and WSL worktrees run a Linux shell even from Windows. */
  launchPlatform?: NodeJS.Platform
  /** Called after the prompt is actually delivered to the agent input path. */
  onPromptDelivered?: () => void
}

function removeStaleLocalAgentTabsForWebHostLaunch(worktreeId: string): void {
  const state = useAppStore.getState()
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    if (tab.launchAgent && !isWebTerminalSurfaceTabId(tab.id)) {
      state.closeTab(tab.id)
    }
  }
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
 * Why: this is the single entry point for "launch agent X in a new tab" from
 * the tab-bar quick-launch menu and the Source Control "send notes to agent"
 * action. It mirrors the `+` button's path (`createNewTerminalTab`) — createTab,
 * flip `activeTabType` to terminal, and persist the appended tab-bar order —
 * then queues the agent startup through the same `pendingStartupByTabId`
 * channel the new-workspace ("cmd+N") flow uses. TerminalPane consumes the
 * queued command on first mount and the local PTY provider writes it once the
 * shell is ready (see `pty-connection.ts`: startup-command path).
 *
 * Default submission mode follows `promptInjectionMode`: argv/flag agents
 * include the prompt directly in the launch command, while followup-path
 * agents launch empty and receive a post-ready draft paste. Generated contexts
 * can override this with draft or submit-after-ready delivery.
 *
 * Returns `null` when no startup plan can be built — for example, a whitespace-
 * only prompt on the trim-empty branch of `buildAgentStartupPlan`. Callers
 * surface that as a launch failure (see `QuickLaunchButton.runLaunch`).
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
  // Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
  // `orca-ide` rename must not be applied for remote launches.
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
    agentEnv
  }
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  // Why: argv/flag agents fold the prompt into the launch command and
  // auto-submit — keeping behavior consistent with the composer/tab-bar `+`
  // mental model, where the prompt is "the first turn the user sent".
  // Followup-path and generated-context launches can deliver a prompt via
  // post-launch bracketed paste; callers decide whether that paste remains a
  // draft or submits after readiness.
  let startupPlan: AgentStartupPlan | null = null
  let pasteDraftAfterLaunch: string | null = null
  let submitPastedPrompt = false
  let forcePasteAfterLaunch = false
  let promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }> | undefined

  if (hasPrompt && promptDelivery === 'submit-after-ready') {
    // Why: generated multi-line prompts are too large to echo through a shell
    // argv/prefill command. Launch cleanly, then paste+submit inside the TUI.
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

  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId) && pasteDraftAfterLaunch === null) {
    // Why: paired web tabs are host-owned and return tabId: null on success.
    // Local-only agent tabs cannot be closed because close routes through
    // session.tabs.close on the host, so prune them before the host snapshot.
    removeStaleLocalAgentTabsForWebHostLaunch(worktreeId)
    void createWebRuntimeSessionTerminal({
      worktreeId,
      environmentId: runtimeEnvironmentId,
      targetGroupId: groupId,
      activate: true,
      ...(hasPrompt
        ? {
            command: startupPlan.launchCommand,
            ...(startupPlan.env ? { env: startupPlan.env } : {}),
            launchConfig: startupPlan.launchConfig,
            launchAgent: agent,
            ...(startupPlan.startupCommandDelivery
              ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
              : {})
          }
        : { agent })
    }).then((created) => {
      // Why: created means the host accepted the launch, not that a local tab
      // exists; keep pruning stale local rows until the snapshot mirrors.
      removeStaleLocalAgentTabsForWebHostLaunch(worktreeId)
      if (!created) {
        toast.error(
          translate(
            'auto.lib.launch.agent.in.new.tab.11cce5cc77',
            'Could not launch {{value0}} in a new terminal.',
            { value0: agent }
          )
        )
        return
      }
      store.setActiveTabType('terminal')
      if (hasPrompt) {
        onPromptDelivered?.()
      }
    })
    return { tabId: null, startupPlan, pasteDraftAfterLaunch: false }
  }

  // Why: queue the startup command BEFORE TerminalPane mounts — it captures
  // `pendingStartupByTabId[tabId]` in useState on first render. If the queue
  // lands after mount the agent binary never starts; the user sees a bare shell.
  // Since both calls happen synchronously in the same React batch, the queue
  // is in place by the time the pane commits.
  // Why: the followup path pastes the prompt as an unsubmitted draft (submit
  // stays false), so gate the initial chat view like a `draft` launch —
  // otherwise a default `auto-submit` followup would open native chat with no
  // submitted turn to render.
  const viewModePromptDelivery =
    hasPrompt && isFollowupPath && promptDelivery === 'auto-submit' ? 'draft' : promptDelivery
  const tab = store.createTab(worktreeId, groupId, undefined, {
    launchAgent: agent,
    quickCommandLabel,
    ...initialAgentTabViewModeProps(store.settings, {
      agent,
      promptDelivery: viewModePromptDelivery,
      nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
        getConnectionIdFromState(store, worktreeId)
      )
    })
  })
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
  // Why: schedule the bracketed-paste-after-ready follow-up immediately after
  // the startup command is queued. Fire-and-forget so callers keep their
  // synchronous `{ tabId, startupPlan }` signature. The helper short-circuits
  // for agents with a `draftPromptFlag`, so calling it on the followup path
  // is safe even when the draft was already injected via the native flag.
  if (pasteDraftAfterLaunch !== null) {
    // Why: surface silent paste failures — without onTimeout, a stalled agent
    // readiness wait drops the user's notes with no feedback. Suppress when
    // the user closed the tab or switched worktrees so the toast/telemetry
    // don't fire for user-initiated cancellation (mirrors the 5s launch
    // watchdog in QuickLaunchButton).
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
          // Why: PTY never spawned — a genuine launch failure. Stay silent so
          // the single notice comes from the caller (source-control dialog
          // toast, or QuickLaunch's watchdog); leaving failureNotified false lets it fire.
          return
        }
        if (!currentTab || state.activeWorktreeId !== worktreeId) {
          // Why: user-initiated cancellation (closed the tab or switched
          // worktrees) — mark notified so the deferred source-control caller
          // suppresses its generic "couldn't start" toast too, not just this nudge.
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
          seedCommandCodeSubmittedPromptStatus(tab.id, trimmedPrompt)
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

  // Why: match the `+` button's `createNewTerminalTab` sequence — without
  // `setActiveTabType('terminal')`, a worktree currently showing an editor
  // file keeps rendering the editor and the new terminal tab stays invisible.
  store.setActiveTabType('terminal')

  // Why: persist the tab-bar order with the new terminal appended. Without
  // this, `reconcileTabOrder` falls back to terminals-first when the stored
  // order is unset, which can jump the new tab to index 0 instead of the end.
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
