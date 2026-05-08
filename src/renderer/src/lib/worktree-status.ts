import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
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
  tabs: Pick<TerminalTab, 'id' | 'title'>[],
  browserTabs: { id: string }[],
  ptyIdsByTabId: Record<string, string[]>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>> = {}
): WorktreeStatus {
  // Why: liveness gates every promotion. tab.ptyId is the wake-hint sessionId
  // preserved across sleep (so wake can reattach to the same daemon history
  // dir / relay session) — it is *not* a liveness signal. ptyIdsByTabId is the
  // source of truth: sleep clears it to []; pty.spawn writes it; pty.kill
  // clears it. Reading the live-pty map keeps the dot honest after sleep,
  // crash, or any path where the wake-hint outlives the actual PTY.
  const liveTabs = tabs.filter((tab) => tabHasLivePty(ptyIdsByTabId, tab.id))

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

/**
 * Apply the WorktreeCard priority overlay (permission > working > done >
 * heuristic) on top of the title-heuristic base. The live-pty precondition is
 * inherited via getWorktreeStatus: when no tab in this worktree has a live
 * PTY and no browser tab exists, getWorktreeStatus returns 'inactive' and
 * none of the promotion paths fire — so retained 'done' rows survive in the
 * card body but the worktree dot is correctly grey on slept/crashed worktrees.
 */
export function resolveWorktreeStatus(args: {
  tabs: Pick<TerminalTab, 'id' | 'title'>[]
  browserTabs: { id: string }[]
  ptyIdsByTabId: Record<string, string[]>
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  hasPermission: boolean
  hasLiveDone: boolean
  hasRetainedDone: boolean
}): WorktreeStatus {
  const heuristic = getWorktreeStatus(
    args.tabs,
    args.browserTabs,
    args.ptyIdsByTabId,
    args.runtimePaneTitlesByTabId ?? {}
  )
  // Why: liveness precondition. Without any live PTY (and no browser tab),
  // agent-state hooks and retained-done snapshots must not promote the dot
  // off grey — the agent process is gone the instant pty.kill fires.
  if (heuristic === 'inactive') {
    return 'inactive'
  }
  if (args.hasPermission) {
    return 'permission'
  }
  // Why: title-heuristic permission must outrank a stale done overlay; doc
  // comment promises priority "permission > working > done > heuristic" and
  // hasPermission can lag the per-pane title detection by a render.
  if (heuristic === 'permission') {
    return 'permission'
  }
  if (heuristic === 'working') {
    return 'working'
  }
  if (args.hasLiveDone || args.hasRetainedDone) {
    return 'done'
  }
  return heuristic
}
