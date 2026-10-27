import { resolveAgentTypeFromTerminalTitle } from '@/components/sidebar/worktree-title-derived-agent-rows'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'
import { tabHasLivePty } from '../../../shared/tab-has-live-pty'
import {
  collectRuntimePaneLeafIds,
  isRuntimePaneTitleOrphan,
  resolveRuntimePaneTitleLeafIdFromRoot
} from '../../../shared/runtime-pane-title-leaf-id'
import { containsAgentSpinnerGlyph } from '../../../shared/agent-title-core'
import { isSyntheticAgentPermissionTitle } from '../../../shared/synthetic-agent-title'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LiveAgentWorktreeStatus } from './worktree-activity-state'
import { rankWorktreeStatus, type WorktreeStatus } from '../../../shared/worktree-status-rollup'

export type { WorktreeStatus } from '../../../shared/worktree-status-rollup'

type WorktreeStatusHeuristicOptions = {
  liveAgentStatus?: LiveAgentWorktreeStatus
  /** An awake chat tab has no PTY until its first message, but the user sees an open session. */
  hasStructuredChat?: boolean
  agentStatusPaneIdsByTabId?: Record<string, ReadonlySet<string>>
  /** Stale rows suppress Orca's generated permission labels; native title fallback stays live. */
  stalePaneIdsByTabId?: Record<string, ReadonlySet<string>>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  terminalLayoutRootsByTabId?: Record<string, TerminalPaneLayoutNode | null | undefined>
}

const STATUS_LABELS: Record<WorktreeStatus, string> = {
  active: 'Active',
  working: 'Working',
  monitoring: 'Monitoring background tasks',
  permission: 'Needs permission',
  failed: 'Failed',
  interrupted: 'Interrupted',
  unconfirmed: 'Couldn’t confirm',
  done: 'Done',
  inactive: 'Inactive'
}

export function getWorktreeStatus(
  tabs: readonly Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>[],
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
  if (options.liveAgentStatus === 'monitoring') {
    return 'monitoring'
  }
  if (liveTabs.length > 0 || browserTabs.length > 0 || options.hasStructuredChat) {
    // Why: browser-only and chat-only worktrees (no PTY) are still active from the user's point of view.
    return 'active'
  }
  return 'inactive'
}

function tabHasStatus(
  tab: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  status: 'permission' | 'working',
  options: WorktreeStatusHeuristicOptions
): boolean {
  const freshPaneIds = options.agentStatusPaneIdsByTabId?.[tab.id]
  const permissionPaneIds = suppressingPaneIds(tab.id, status, options)
  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    const tabLayoutRoot =
      options.terminalLayoutRootsByTabId?.[tab.id] ?? options.terminalLayoutsByTabId?.[tab.id]?.root
    const paneTitleEntries = Object.entries(paneTitles)
    const layoutLeafIds = tabLayoutRoot ? new Set(collectRuntimePaneLeafIds(tabLayoutRoot)) : null
    let hasCurrentPaneTitle = false
    for (const [runtimePaneId, title] of paneTitleEntries) {
      const agentStatusPaneIds =
        status === 'permission' && isSyntheticAgentPermissionTitle(title)
          ? permissionPaneIds
          : freshPaneIds
      const leafId = resolveRuntimePaneTitleLeafIdFromRoot(tabLayoutRoot, runtimePaneId)
      // A removed pane's last title is no longer evidence for this tab.
      if (layoutLeafIds && isRuntimePaneTitleOrphan(tabLayoutRoot, runtimePaneId, layoutLeafIds)) {
        continue
      }
      hasCurrentPaneTitle = true
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
      if (
        classifyTitleActivity(title) === status &&
        titleStatusIsAgentAttributable(title, tab.launchAgent)
      ) {
        return true
      }
    }
    if (hasCurrentPaneTitle) {
      return false
    }
  }
  // Why: a tab title can't identify its pane; once an agent row owns one, prefer the row over a completed pane's stale "working" title.
  const agentStatusPaneIds =
    status === 'permission' && isSyntheticAgentPermissionTitle(tab.title)
      ? permissionPaneIds
      : freshPaneIds
  if (agentStatusPaneIds && agentStatusPaneIds.size > 0) {
    return false
  }
  return (
    classifyTitleActivity(tab.title) === status &&
    titleStatusIsAgentAttributable(tab.title, tab.launchAgent)
  )
}

/**
 * Pane ids whose title must not drive `status` for this tab. Fresh rows suppress every heuristic;
 * stale rows suppress synthetic permission labels only. Returns the fresh set itself
 * when there is nothing to add, so the common path allocates nothing.
 */
function suppressingPaneIds(
  tabId: string,
  status: 'permission' | 'working',
  options: WorktreeStatusHeuristicOptions
): ReadonlySet<string> | undefined {
  const fresh = options.agentStatusPaneIdsByTabId?.[tabId]
  if (status !== 'permission') {
    return fresh
  }
  const stale = options.stalePaneIdsByTabId?.[tabId]
  if (!stale || stale.size === 0) {
    return fresh
  }
  if (!fresh || fresh.size === 0) {
    return stale
  }
  return new Set([...fresh, ...stale])
}

// Why: require agent attribution so a bare never-cleared spinner title can't spin the dot "0 agents" forever with no matching sidebar row.
function titleStatusIsAgentAttributable(title: string, launchAgent?: TuiAgent | null): boolean {
  if (resolveAgentTypeFromTerminalTitle(title) !== null) {
    return true
  }
  // Spinner proves activity, not provider (Claude titles lack it, #9040); use launch identity like sidebar rows (#9647).
  return containsAgentSpinnerGlyph(title) && Boolean(launchAgent)
}

export function getWorktreeStatusLabel(status: WorktreeStatus): string {
  return STATUS_LABELS[status]
}

/**
 * Apply the WorktreeCard priority overlay on top of the title-heuristic base. Explicit agent rows may
 * promote the dot; sleep cleanup owns removing stale retained rows.
 *
 * Map args are narrowed to this worktree. `hasPermission`/`hasLiveWorking`/
 * `hasLiveDone` are fresh hook entries ({blocked,waiting} / {working} / {done});
 * `hasRetainedDone`/`hasRetainedFailed` are retained-agent snapshots scoped to this worktreeId.
 */
export function resolveWorktreeStatus(args: {
  tabs: readonly Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>[]
  browserTabs: readonly { id: string }[]
  hasStructuredChat?: boolean
  ptyIdsByTabId: Record<string, string[]>
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  agentStatusPaneIdsByTabId?: Record<string, ReadonlySet<string>>
  stalePaneIdsByTabId?: Record<string, ReadonlySet<string>>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  terminalLayoutRootsByTabId?: Record<string, TerminalPaneLayoutNode | null | undefined>
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring?: boolean
  hasFailed?: boolean
  hasInterrupted?: boolean
  hasUnconfirmed?: boolean
  hasLiveDone: boolean
  hasRetainedDone: boolean
  hasRetainedFailed?: boolean
}): WorktreeStatus {
  const heuristic = getWorktreeStatus(
    args.tabs,
    args.browserTabs,
    args.ptyIdsByTabId,
    args.runtimePaneTitlesByTabId ?? {},
    {
      hasStructuredChat: args.hasStructuredChat,
      agentStatusPaneIdsByTabId: args.agentStatusPaneIdsByTabId,
      stalePaneIdsByTabId: args.stalePaneIdsByTabId,
      terminalLayoutsByTabId: args.terminalLayoutsByTabId,
      terminalLayoutRootsByTabId: args.terminalLayoutRootsByTabId
    }
  )
  return rankWorktreeStatus(heuristic, args)
}
