import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'

export type LaunchAgentInNewTabArgs = {
  agent: TuiAgent
  worktreeId: string
  /** The tab group the user clicked from. Keeps split-group launches in the
   *  pane the user initiated from instead of falling through to the active group. */
  groupId?: string
  /** Optional initial prompt. When non-empty, dispatched per the agent's
   *  `promptInjectionMode`: argv/flag agents auto-submit via the launch
   *  command; followup-path agents land the prompt as an unsent draft. */
  prompt?: string
  /** Telemetry surface that initiated this launch. Defaults to the tab-bar
   *  quick-launch entry point so existing callers stay unchanged. */
  launchSource?: LaunchSource
}

export type LaunchAgentInNewTabResult = {
  tabId: string
  startupPlan: AgentStartupPlan
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
 * Submission mode by `promptInjectionMode`: argv/flag agents include the
 * prompt directly in the launch command (auto-submit, atomic via the shell);
 * followup-path agents have no argv prompt slot, so we launch empty-prompt
 * and bracketed-paste the prompt as an unsent draft once the agent's input
 * box is ready.
 *
 * Returns `null` when no startup plan can be built — for example, a whitespace-
 * only prompt on the trim-empty branch of `buildAgentStartupPlan`. Callers
 * surface that as a launch failure (see `QuickLaunchButton.runLaunch`).
 */
export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  const { agent, worktreeId, groupId, prompt, launchSource } = args
  const store = useAppStore.getState()
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'

  // Why: argv/flag agents fold the prompt into the launch command and
  // auto-submit — keeping behavior consistent with the composer/tab-bar `+`
  // mental model, where the prompt is "the first turn the user sent".
  // Followup-path agents have no argv prompt slot, so the only way to
  // deliver a prompt is post-launch bracketed paste; we leave it as an
  // unsent draft so the user confirms before sending (avoids the typed-`\r`
  // race if readiness detection misses).
  let startupPlan: AgentStartupPlan | null = null
  let pasteDraftAfterLaunch: string | null = null

  if (hasPrompt && isFollowupPath) {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: '',
      cmdOverrides,
      platform: CLIENT_PLATFORM,
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = trimmedPrompt
  } else {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: hasPrompt ? trimmedPrompt : '',
      cmdOverrides,
      platform: CLIENT_PLATFORM,
      allowEmptyPromptLaunch: !hasPrompt
    })
  }

  if (!startupPlan) {
    return null
  }

  // Why: queue the startup command BEFORE TerminalPane mounts — it captures
  // `pendingStartupByTabId[tabId]` in useState on first render. If the queue
  // lands after mount the agent binary never starts; the user sees a bare shell.
  // Since both calls happen synchronously in the same React batch, the queue
  // is in place by the time the pane commits.
  //
  // The telemetry payload is threaded through the queue → pty-connection →
  // pty-transport → pty:spawn IPC → main, where main fires `agent_started`
  // only after the spawn succeeds. `request_kind: 'new'` because
  // quick-launch always opens a fresh session.
  const tab = store.createTab(worktreeId, groupId)
  store.queueTabStartupCommand(tab.id, {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
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
    const tabId = tab.id
    void pasteDraftWhenAgentReady({
      tabId,
      content: pasteDraftAfterLaunch,
      agent,
      onTimeout: () => {
        const state = useAppStore.getState()
        const tabsForWorktree = state.tabsByWorktree[worktreeId] ?? []
        const tab = tabsForWorktree.find((t) => t.id === tabId)
        // Why: if the PTY never spawned, QuickLaunch's 5s watchdog already
        // surfaced the launch failure. Don't double-toast for the same root
        // cause. Looking up directly in `worktreeId` (not scanning every
        // worktree) also preserves "still in this worktree" intent.
        if (!tab) {
          return // tab closed by user
        }
        if (tab.ptyId === null) {
          return // launch failed; QuickLaunch handled the user-facing toast
        }
        if (state.activeWorktreeId !== worktreeId) {
          return
        }
        toast.message("Your notes weren't sent — paste them once the agent is ready.")
        track('agent_error', {
          error_class: 'paste_readiness_timeout',
          agent_kind: tuiAgentToAgentKind(agent)
        })
      }
    })
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

  return { tabId: tab.id, startupPlan }
}
