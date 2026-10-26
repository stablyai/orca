import { useAppStore } from '@/store'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import {
  flattenTerminalQuickCommand,
  isTerminalAgentQuickCommand,
  supportsTerminalAgentQuickCommand
} from '../../../shared/terminal-quick-commands'
import type { TerminalQuickCommand } from '../../../shared/terminal-quick-command-types'

export type RunQuickCommandInNewTabArgs = {
  command: TerminalQuickCommand
  worktreeId: string
  historyId?: string
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

function resolveQuickCommandLaunchGroupId(
  worktreeId: string,
  requestedGroupId: string | null | undefined
): string | null {
  return requestedGroupId ?? useAppStore.getState().activeGroupIdByWorktree[worktreeId] ?? null
}

/** Queue terminal commands until shell readiness and always append Enter (run differs from right-click Insert). Agent prompts use their launch path; OpenCode2 submits after TUI readiness because --prompt can remain unsent. */
export function runQuickCommandInNewTab({
  command,
  worktreeId,
  groupId,
  historyId = command.id
}: RunQuickCommandInNewTabArgs): { tabId: string } | null {
  const targetGroupId = groupId ?? undefined
  if (isTerminalAgentQuickCommand(command)) {
    if (!command.prompt.trim() || !supportsTerminalAgentQuickCommand(command.agent)) {
      return null
    }
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: command.agent,
      prompt: command.prompt,
      worktreeId,
      groupId: targetGroupId,
      ...(command.agent === 'opencode' || command.agent === 'opencode2'
        ? { promptDelivery: 'submit-after-ready' as const }
        : {}),
      launchSource: 'quick_command',
      quickCommandLabel: command.label
    })
    if (result?.surface.kind === 'local-terminal') {
      const launchedGroupId = resolveQuickCommandGroupId(worktreeId, result.surface.tabId, groupId)
      if (launchedGroupId) {
        useAppStore.getState().setRecentQuickCommandForGroup(launchedGroupId, historyId)
      }
      return { tabId: result.surface.tabId }
    }
    if (result?.surface.kind === 'host-published') {
      const launchedGroupId = resolveQuickCommandLaunchGroupId(worktreeId, groupId)
      if (launchedGroupId) {
        useAppStore.getState().setRecentQuickCommandForGroup(launchedGroupId, historyId)
      }
    }
    if (result) {
      return null
    }
    return null
  }

  // Reject whitespace-only input before spawning an unexplained empty terminal.
  if (!command.command.trim()) {
    return null
  }
  const store = useAppStore.getState()
  const tab = store.createTab(worktreeId, targetGroupId, undefined, {
    quickCommandLabel: command.label,
    pendingStartup: { command: flattenTerminalQuickCommand(command).command }
  })

  // Switch to terminal view like the + button; otherwise an editor keeps the new tab invisible.
  store.setActiveTabType('terminal', worktreeId)

  // Persist appended order or reconciliation’s terminals-first fallback moves the new tab to index zero.
  persistAgentLaunchTabOrder(worktreeId, tab.id)

  const launchedGroupId = resolveQuickCommandGroupId(worktreeId, tab.id, groupId)
  if (launchedGroupId) {
    useAppStore.getState().setRecentQuickCommandForGroup(launchedGroupId, historyId)
  }

  return { tabId: tab.id }
}
