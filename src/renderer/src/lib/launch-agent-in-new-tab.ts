import { useAppStore } from '@/store'
import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import type { TuiAgent } from '../../../shared/types'

export type LaunchAgentInNewTabArgs = {
  agent: TuiAgent
  worktreeId: string
  /** The tab group the user clicked from. Keeps split-group launches in the
   *  pane the user initiated from instead of falling through to the active group. */
  groupId?: string
}

export type LaunchAgentInNewTabResult = {
  tabId: string
  startupPlan: AgentStartupPlan
} | null

/**
 * Create a new terminal tab and queue the agent's empty-prompt launch command.
 *
 * Why: this is the single entry point for "launch agent X in a new tab" from
 * the tab-bar quick-launch menu. It mirrors the `+` button's path
 * (`createNewTerminalTab`) — createTab, flip `activeTabType` to terminal, and
 * persist the appended tab-bar order — then queues the empty-prompt agent
 * startup through the same `pendingStartupByTabId` channel the
 * new-workspace ("cmd+N") flow uses. TerminalPane consumes the queued command
 * on first mount and the local PTY provider writes it once the shell is ready
 * (see `pty-connection.ts`: startup-command path), so the CLI boots in exactly
 * the same way as a composer-initiated launch.
 *
 * Returns `null` when `buildAgentStartupPlan` cannot produce a plan (should
 * not happen with `allowEmptyPromptLaunch: true` but guarded for safety).
 */
export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  const { agent, worktreeId, groupId } = args
  const store = useAppStore.getState()

  // Why: empty-prompt launch is the whole point of quick-launch — the user
  // just wants to get into the agent's input box with no prefilled prompt.
  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: '',
    cmdOverrides: store.settings?.agentCmdOverrides ?? {},
    platform: CLIENT_PLATFORM,
    allowEmptyPromptLaunch: true
  })
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
  // quick-launch always opens a fresh empty-prompt session.
  const tab = store.createTab(worktreeId, groupId)
  store.queueTabStartupCommand(tab.id, {
    command: startupPlan.launchCommand,
    telemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: 'tab_bar_quick_launch',
      request_kind: 'new'
    }
  })

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
