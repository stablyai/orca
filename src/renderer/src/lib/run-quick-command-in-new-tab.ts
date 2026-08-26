import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import {
  flattenTerminalQuickCommand,
  isTerminalAgentQuickCommand,
  shouldOpenTerminalQuickCommandInBackground,
  supportsTerminalAgentQuickCommand
} from '../../../shared/terminal-quick-commands'
import type { TerminalQuickCommand } from '../../../shared/terminal-quick-command-types'
import { translate } from '@/i18n/i18n'

export type RunQuickCommandInNewTabArgs = {
  command: TerminalQuickCommand
  worktreeId: string
  historyId?: string
  /** Tab group the user clicked from. Keeps the spawned terminal in the
   *  pane the user initiated from when available. */
  groupId?: string | null
  /** Initial cwd inherited from the terminal pane that launched the command. */
  initialCwd?: string | null
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

function notifyAgentPromptDeliveryFailed(): void {
  toast.error(
    translate(
      'auto.lib.runQuickCommandInNewTab.agentPromptDeliveryFailed',
      'The agent started, but the Quick Command prompt could not be sent.'
    )
  )
}

function notifyRemoteLaunchFailed(message?: string): void {
  toast.error(
    message ||
      translate(
        'auto.lib.runQuickCommandInNewTab.remoteLaunchFailed',
        'Could not run the Quick Command on the remote host.'
      )
  )
}

/** Runs a Quick Command in a fresh terminal without stealing focus when configured for background. */
export function runQuickCommandInNewTab({
  command,
  worktreeId,
  groupId,
  initialCwd,
  historyId = command.id
}: RunQuickCommandInNewTabArgs): { tabId: string } | null {
  const targetGroupId = groupId ?? undefined
  const openInBackground = shouldOpenTerminalQuickCommandInBackground(command)
  if (isTerminalAgentQuickCommand(command)) {
    if (!command.prompt.trim() || !supportsTerminalAgentQuickCommand(command.agent)) {
      return null
    }
    const result = launchAgentInNewTab({
      agent: command.agent,
      prompt: command.prompt,
      worktreeId,
      groupId: targetGroupId,
      ...(initialCwd?.trim() ? { initialCwd } : {}),
      ...(openInBackground ? { activate: false } : {}),
      launchSource: 'quick_command',
      quickCommandLabel: command.label
    })
    if (result?.tabId) {
      if (openInBackground) {
        requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [result.tabId] })
      }
      const launchedGroupId = resolveQuickCommandGroupId(worktreeId, result.tabId, groupId)
      if (launchedGroupId) {
        useAppStore.getState().setRecentQuickCommandForGroup(launchedGroupId, historyId)
      }
      return { tabId: result.tabId }
    }
    if (openInBackground && result?.promptDeliveryResult) {
      const launchedGroupId =
        groupId ?? useAppStore.getState().activeGroupIdByWorktree[worktreeId] ?? null
      void result.promptDeliveryResult
        .then(({ delivered, failureNotified }) => {
          if (!delivered) {
            if (!failureNotified) {
              notifyAgentPromptDeliveryFailed()
            }
            return
          }
          if (launchedGroupId) {
            useAppStore.getState().setRecentQuickCommandForGroup(launchedGroupId, historyId)
          }
        })
        .catch((error) => {
          console.error('Quick Command prompt delivery failed', error)
          notifyAgentPromptDeliveryFailed()
        })
    }
    return null
  }

  // Why: avoid creating an unexplained blank terminal for an empty command.
  if (!command.command.trim()) {
    return null
  }
  const store = useAppStore.getState()
  const runtimeEnvironmentId = openInBackground
    ? getRuntimeEnvironmentIdForWorktree(store, worktreeId)
    : null
  if (openInBackground && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    const launchedGroupId = groupId ?? store.activeGroupIdByWorktree[worktreeId] ?? null
    void createWebRuntimeSessionTerminal({
      worktreeId,
      environmentId: runtimeEnvironmentId,
      targetGroupId,
      command: flattenTerminalQuickCommand(command).command,
      ...(initialCwd?.trim() ? { cwd: initialCwd } : {}),
      activate: false,
      selectWorktree: false
    })
      .then((outcome) => {
        if (outcome.status === 'failed') {
          notifyRemoteLaunchFailed(outcome.message)
          return
        }
        if (launchedGroupId) {
          useAppStore.getState().setRecentQuickCommandForGroup(launchedGroupId, historyId)
        }
      })
      .catch((error) => {
        console.error('Quick Command remote launch failed', error)
        notifyRemoteLaunchFailed()
      })
    return null
  }
  const tab = store.createTab(worktreeId, targetGroupId, undefined, {
    quickCommandLabel: command.label,
    ...(openInBackground ? { activate: false } : {})
  })

  if (initialCwd?.trim()) {
    store.queueTabInitialCwd(tab.id, initialCwd)
  }
  store.queueTabStartupCommand(tab.id, {
    command: flattenTerminalQuickCommand(command).command
  })
  if (openInBackground) {
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })
  }

  // Why: match `+` button's createNewTerminalTab — without this, a worktree
  // currently showing an editor file keeps rendering the editor and the new
  // terminal tab stays invisible.
  if (!openInBackground) {
    store.setActiveTabType('terminal')
  }

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
    fresh.setRecentQuickCommandForGroup(launchedGroupId, historyId)
  }

  return { tabId: tab.id }
}
