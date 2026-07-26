import { resolveAgentTypeFromTerminalTitle } from '@/components/sidebar/worktree-title-derived-agent-rows'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { resolveRuntimePaneTitleLeafIdFromRoot } from '@/lib/runtime-pane-title-leaf-id'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/types'
import type { LiveAgentWorktreeStatus } from './worktree-activity-state'

export type WorktreeStatus = 'active' | 'working' | 'permission' | 'done' | 'inactive'

type WorktreeStatusHeuristicOptions = {
  liveAgentStatus?: LiveAgentWorktreeStatus
  agentStatusPaneIdsByTabId?: Record<string, ReadonlySet<string>>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  terminalLayoutRootsByTabId?: Record<string, TerminalPaneLayoutNode | null | undefined>
}

const STATUS_LABELS: Record<WorktreeStatus, string> = {
  active: 'Active',
  working: 'Working',
  permission: 'Needs permission',
  done: 'Done',
  inactive: 'Inactive'
}

export function getWorktreeStatus(
  tabs: readonly Pick<TerminalTab, 'id' | 'title'>[],
  browserTabs: readonly { id: string }[],
  ptyIdsByTabId: Record<string, string[]>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>> = {},
  options: WorktreeStatusHeuristicOptions = {}
): WorktreeStatus {
  // Why: tab.ptyId is a wake-hint that survives sleep, not a liveness signal; gate on ptyIdsByTabId, which sleep/kill clear when the PTY dies.
  const liveTabs = tabs.filter((tab) => tabHasLivePty(ptyIdsByTabId, tab.id))

  // Why: tab.title tracks only the most-recently-focused pane (onActivePaneChange in use-terminal-pane-lifecycle.ts); consult per-pane titles so the spinner reflects aggregate tab state.
  const hasStatus = (status: 'permission' | 'working'): boolean =>
    liveTabs.some((tab) => tabHasStatus(tab, runtimePaneTitlesByTabId, status, options))

  if (options.liveAgentStatus === 'permission' || hasStatus('permission')) {
    return 'permission'
  }
  if (options.liveAgentStatus === 'working' || hasStatus('working')) {
    return 'working'
  }
  if (liveTabs.length > 0 || browserTabs.length > 0) {
    // Why: browser-only worktrees (no PTY) are still active from the user's point of view.
    return 'active'
  }
  return 'inactive'
}

function tabHasStatus(
  tab: Pick<TerminalTab, 'id' | 'title'>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  status: 'permission' | 'working',
  options: WorktreeStatusHeuristicOptions
): boolean {
  const agentStatusPaneIds = options.agentStatusPaneIdsByTabId?.[tab.id]
  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    const tabLayoutRoot =
      options.terminalLayoutRootsByTabId?.[tab.id] ?? options.terminalLayoutsByTabId?.[tab.id]?.root
    const paneTitleEntries = Object.entries(paneTitles)
    for (const [runtimePaneId, title] of paneTitleEntries) {
      const leafId = resolveRuntimePaneTitleLeafIdFromRoot(tabLayoutRoot, runtimePaneId)
      // Why: runtime titles can precede layout hydration (SSH/replay); with one title and one agent row, prefer that row over a stale spinner.
      const hasSingleUnmappedAgentStatusPane =
        leafId === null && agentStatusPaneIds?.size === 1 && paneTitleEntries.length === 1
      if (
        agentStatusPaneIds?.has(runtimePaneId) ||
        (leafId !== null && agentStatusPaneIds?.has(leafId)) ||
        hasSingleUnmappedAgentStatusPane
      ) {
        continue
      }
      if (classifyTitleActivity(title) === status && titleStatusIsAgentAttributable(title)) {
        return true
      }
    }
    return false
  }
  // Why: a tab title can't identify its pane; once an agent row owns one, prefer the row over a completed pane's stale "working" title.
  if (agentStatusPaneIds && agentStatusPaneIds.size > 0) {
    return false
  }
  return classifyTitleActivity(tab.title) === status && titleStatusIsAgentAttributable(tab.title)
}

// Why: require agent attribution so a bare never-cleared spinner title can't spin the dot "0 agents" forever with no matching sidebar row.
function titleStatusIsAgentAttributable(title: string): boolean {
  return resolveAgentTypeFromTerminalTitle(title) !== null
}

export function getWorktreeStatusLabel(status: WorktreeStatus): string {
  return STATUS_LABELS[status]
}

/**
 * Apply the WorktreeCard priority overlay (permission > working > done >
 * heuristic) on top of the title-heuristic base. Explicit agent rows may
 * promote the dot; sleep cleanup owns removing stale retained rows.
 *
 * Map args are narrowed to this worktree. `hasPermission`/`hasLiveWorking`/
 * `hasLiveDone` are fresh hook entries ({blocked,waiting} / {working} / {done});
 * `hasRetainedDone` is a retained-agent snapshot scoped to this worktreeId.
 */
export function resolveWorktreeStatus(args: {
  tabs: readonly Pick<TerminalTab, 'id' | 'title'>[]
  browserTabs: readonly { id: string }[]
  ptyIdsByTabId: Record<string, string[]>
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  agentStatusPaneIdsByTabId?: Record<string, ReadonlySet<string>>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  terminalLayoutRootsByTabId?: Record<string, TerminalPaneLayoutNode | null | undefined>
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveDone: boolean
  hasRetainedDone: boolean
}): WorktreeStatus {
  const heuristic = getWorktreeStatus(
    args.tabs,
    args.browserTabs,
    args.ptyIdsByTabId,
    args.runtimePaneTitlesByTabId ?? {},
    {
      agentStatusPaneIdsByTabId: args.agentStatusPaneIdsByTabId,
      terminalLayoutsByTabId: args.terminalLayoutsByTabId,
      terminalLayoutRootsByTabId: args.terminalLayoutRootsByTabId
    }
  )
  if (args.hasPermission) {
    return 'permission'
  }
  // Why: heuristic 'permission' outranks heuristic 'working' — the user-actionable signal wins when panes in one tab disagree.
  if (heuristic === 'permission') {
    return 'permission'
  }
  // Why: restored cards get the hook snapshot before panes mount; trust the explicit working row so they stay yellow on restart.
  if (args.hasLiveWorking || heuristic === 'working') {
    return 'working'
  }
  if (args.hasLiveDone || args.hasRetainedDone) {
    return 'done'
  }
  return heuristic
}
