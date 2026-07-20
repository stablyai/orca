import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { RUN_TERMINAL_COMMAND_EVENT, type RunTerminalCommandDetail } from '@/constants/terminal'
import {
  buildTerminalQuickCommandInput,
  flattenTerminalQuickCommand,
  isTerminalAgentQuickCommand,
  supportsTerminalAgentQuickCommand
} from '../../../shared/terminal-quick-commands'
import { isShellProcess } from '../../../shared/shell-process-detection'
import type { TerminalCommandQuickCommand, TerminalQuickCommand } from '../../../shared/types'

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
 * Try to reuse the terminal a reuse-enabled quick command already spawned in
 * this worktree, instead of opening another tab. Re-running focuses that
 * terminal and re-sends the command — but only when it is sitting idle at a
 * prompt. If a foreground process is still running (e.g. `npm run dev`) or the
 * shell is dead, we leave it alone and let the caller open a fresh tab, so a
 * live server is never disturbed and tabs only pile up when each is actually
 * busy. Returns the reused tab id, or null when no idle reuse target exists.
 */
async function reuseQuickCommandTerminalTab({
  command,
  worktreeId
}: {
  command: TerminalCommandQuickCommand
  worktreeId: string
}): Promise<string | null> {
  const state = useAppStore.getState()
  const candidates = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'terminal' && tab.quickCommandId === command.id
  )
  if (candidates.length === 0) {
    return null
  }

  for (const candidate of candidates) {
    const ptyId = state.ptyIdsByTabId[candidate.id]?.[0]
    if (!ptyId) {
      continue
    }

    // One call separates the three states we care about: null = dead shell (or
    // the web runtime, where this is stubbed null), a shell name = idle prompt,
    // anything else = a foreground process still running. Only an idle prompt is
    // safe to re-run in.
    // Why: callers invoke runQuickCommandInNewTab with `void`, so a rejected IPC
    // here would surface as an unhandled rejection and skip the new-tab fallback.
    // Treat a failed probe as "not reusable" and move on to the next candidate.
    let foreground: string | null
    try {
      foreground = await window.api.pty.getForegroundProcess(ptyId)
    } catch {
      continue
    }
    if (!foreground || !isShellProcess(foreground)) {
      continue
    }

    const latest = useAppStore.getState()
    latest.activateTab(candidate.id)
    latest.focusGroup(worktreeId, candidate.groupId)
    latest.setActiveTabType('terminal')
    latest.setRecentQuickCommandForGroup(candidate.groupId, command.id)

    window.dispatchEvent(
      new CustomEvent<RunTerminalCommandDetail>(RUN_TERMINAL_COMMAND_EVENT, {
        detail: {
          tabId: candidate.id,
          // Why: re-run against the exact PTY we just probed for idleness so the
          // receiver lands the command in that pane, not a different split pane.
          ptyId,
          // Force Enter: the split button is a "run" affordance regardless of the
          // command's Insert-mode `appendEnter` preference.
          input: buildTerminalQuickCommandInput({
            ...flattenTerminalQuickCommand(command),
            appendEnter: true
          })
        }
      })
    )

    return candidate.id
  }

  return null
}

/**
 * Spawn a fresh terminal tab in the given group and queue the quick-command
 * text as the startup command. The PTY connection layer writes the command
 * once the shell is ready, so the user always sees their first prompt before
 * the command runs (mirrors the agent quick-launch path in
 * `launchAgentInNewTab`).
 *
 * When the command opts into tab reuse (`reuseTab`), a re-run first tries to
 * focus and re-run in the terminal it already spawned (see
 * `reuseQuickCommandTerminalTab`); it only falls through to a new tab when no
 * idle reuse target exists.
 *
 * Terminal-command quick commands always append Enter — the split-button is
 * a "run" affordance, distinct from the right-click "Insert" mode where
 * `appendEnter: false` is honored. Agent-prompt quick commands use the
 * agent's normal prompt launch command instead of post-launch TUI paste.
 */
export async function runQuickCommandInNewTab({
  command,
  worktreeId,
  groupId
}: RunQuickCommandInNewTabArgs): Promise<{ tabId: string } | null> {
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
      launchSource: 'quick_command',
      quickCommandLabel: command.label
    })
    if (result?.tabId) {
      const launchedGroupId = resolveQuickCommandGroupId(worktreeId, result.tabId, groupId)
      if (launchedGroupId) {
        useAppStore.getState().setRecentQuickCommandForGroup(launchedGroupId, command.id)
      }
      return { tabId: result.tabId }
    }
    if (result) {
      return null
    }
    return null
  }

  // Why: a whitespace-only command would still spawn a terminal but feed it an
  // empty string, leaving the user with an unexplained blank tab. Refuse early.
  if (!command.command.trim()) {
    return null
  }

  // Why: reuse-enabled commands first try to land back in their own idle
  // terminal; only fall through to a new tab when none is reusable.
  if (command.reuseTab === true) {
    const reusedTabId = await reuseQuickCommandTerminalTab({ command, worktreeId })
    if (reusedTabId) {
      return { tabId: reusedTabId }
    }
  }

  const store = useAppStore.getState()
  const tab = store.createTab(worktreeId, targetGroupId, undefined, {
    quickCommandLabel: command.label,
    // Why: stamp the originating command id only for reuse-enabled commands so a
    // later run can find this terminal. Non-reuse commands stay unmarked and
    // always open a new tab.
    ...(command.reuseTab === true ? { quickCommandId: command.id } : {})
  })

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
