import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import type { TerminalTab } from '../../../shared/types'

export type WorktreeStatus = 'active' | 'working' | 'permission' | 'done' | 'inactive'

const STATUS_LABELS: Record<WorktreeStatus, string> = {
  active: 'Active',
  working: 'Working',
  permission: 'Needs permission',
  done: 'Done',
  inactive: 'Inactive'
}

export function getWorktreeStatus(
  tabs: Pick<TerminalTab, 'id' | 'ptyId' | 'title'>[],
  browserTabs: { id: string }[],
  runtimePaneTitlesByTabId: Record<string, Record<number, string>> = {}
): WorktreeStatus {
  const liveTabs = tabs.filter((tab) => tab.ptyId)

  // Why: a split-pane tab can host multiple concurrent agents, but `tab.title`
  // only reflects the most-recently-focused pane (see onActivePaneChange in
  // use-terminal-pane-lifecycle.ts). Reading just `tab.title` causes the
  // sidebar spinner to follow the focused pane instead of the aggregate tab
  // state — e.g. clicking an idle Claude pane while Codex is still working in
  // another pane would collapse the spinner to solid green. Consult per-pane
  // titles first (same pattern as countWorkingAgentsForTab) and only fall back
  // to `tab.title` for tabs that have no mounted panes yet.
  const hasStatus = (status: 'permission' | 'working'): boolean =>
    liveTabs.some((tab) => tabHasStatus(tab, runtimePaneTitlesByTabId, status))

  if (hasStatus('permission')) {
    return 'permission'
  }
  if (hasStatus('working')) {
    return 'working'
  }
  if (liveTabs.length > 0 || browserTabs.length > 0) {
    // Why: browser-only worktrees are still active from the user's point of
    // view even when they have no PTY-backed terminal. The sidebar filter
    // already treats them as active, so every navigation surface must reuse
    // that rule instead of showing a misleading inactive dot.
    return 'active'
  }
  return 'inactive'
}

function tabHasStatus(
  tab: Pick<TerminalTab, 'id' | 'title'>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  status: 'permission' | 'working'
): boolean {
  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    for (const title of Object.values(paneTitles)) {
      if (detectAgentStatusFromTitle(title) === status) {
        return true
      }
    }
    return false
  }
  return detectAgentStatusFromTitle(tab.title) === status
}

export function getWorktreeStatusLabel(status: WorktreeStatus): string {
  return STATUS_LABELS[status]
}
