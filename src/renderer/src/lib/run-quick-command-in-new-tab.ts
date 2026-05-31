import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import {
  flattenTerminalQuickCommand,
  isTerminalAgentQuickCommand,
  supportsTerminalAgentQuickCommand
} from '../../../shared/terminal-quick-commands'
import type { TerminalQuickCommand } from '../../../shared/types'

export type RunQuickCommandInNewTabArgs = {
  command: TerminalQuickCommand
  worktreeId: string
  /** Tab group the user clicked from. Keeps the spawned terminal in the
   *  pane the user initiated from when available. */
  groupId?: string | null
}

function resolveQuickCommandGroupId(
  worktreeId: string,
  tabId: string,
  fallbackGroupId: string | null | undefined
): string | null {
  const state = useAppStore.getState()
  return (
    state.unifiedTabsByWorktree[worktreeId]?.find(
      (tab) => tab.entityId === tabId && tab.contentType === 'terminal'
    )?.groupId ??
    fallbackGroupId ??
    state.activeGroupIdByWorktree[worktreeId] ??
    null
  )
}

/**
 * Spawn a fresh terminal tab in the given group and queue the quick-command
 * text as the startup command. The PTY connection layer writes the command
 * once the shell is ready, so the user always sees their first prompt before
 * the command runs (mirrors the agent quick-launch path in
 * `launchAgentInNewTab`).
 *
 * Terminal-command quick commands always append Enter — the split-button is
 * a "run" affordance, distinct from the right-click "Insert" mode where
 * `appendEnter: false` is honored. Agent-prompt quick commands use the
 * agent's normal prompt launch command instead of post-launch TUI paste.
 */
export function runQuickCommandInNewTab({
  command,
  worktreeId,
  groupId
}: RunQuickCommandInNewTabArgs): { tabId: string } | null {
  const targetGroupId = groupId ?? undefined
  if (isTerminalAgentQuickCommand(command)) {
    if (!command.prompt.trim() || !supportsTerminalAgentQuickCommand(command.agent)) {
      return null
    }
    const result = launchAgentInNewTab({
      agent: command.agent,
      prompt: command.prompt,
      worktreeId,
      groupId: targetGroupId,
      launchSource: 'quick_command'
    })
    if (result) {
      const launchedGroupId = resolveQuickCommandGroupId(worktreeId, result.tabId, groupId)
      if (launchedGroupId) {
        useAppStore.getState().setRecentQuickCommandForGroup(launchedGroupId, command.id)
      }
      return { tabId: result.tabId }
    }
    return null
  }

  // Why: a whitespace-only command would still spawn a terminal but feed it an
  // empty string, leaving the user with an unexplained blank tab. Refuse early.
  if (!command.command.trim()) {
    return null
  }
  const store = useAppStore.getState()
  const tab = store.createTab(worktreeId, targetGroupId)

  store.queueTabStartupCommand(tab.id, {
    command: flattenTerminalQuickCommand(command).command
  })

  // Why: match `+` button's createNewTerminalTab — without this, a worktree
  // currently showing an editor file keeps rendering the editor and the new
  // terminal tab stays invisible.
  store.setActiveTabType('terminal')

  // Why: persist tab-bar order with the new terminal appended. Without this,
  // reconcileTabOrder falls back to terminals-first when the stored order is
  // unset, jumping the new tab to index 0.
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

  const launchedGroupId = resolveQuickCommandGroupId(worktreeId, tab.id, groupId)
  if (launchedGroupId) {
    fresh.setRecentQuickCommandForGroup(launchedGroupId, command.id)
  }

  return { tabId: tab.id }
}
