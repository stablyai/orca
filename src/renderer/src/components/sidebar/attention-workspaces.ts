import { classifyTitleActivity, isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import type { AppState } from '@/store/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { FIRST_PANE_ID } from '../../../../shared/pane-key'
import { isSyntheticAgentPermissionTitle } from '../../../../shared/synthetic-agent-title'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { collectLeafIds } from '../terminal-pane/terminal-pane-layout-tree'
import {
  createTitleFallbackLeafResolver,
  titleStatusToRowState
} from './worktree-title-derived-agent-rows'
import { resolveAttentionWorkspaceKeys } from './attention-workspace-owners'

/**
 * The store slices an attention verdict reads. Deliberately narrow: the dashboard's
 * cross-worktree aggregate answers a much bigger question and pays for it (see the read-set
 * note on `useWorktreeAgentRows`), while a collapsed header only needs "does anything here
 * wait on me".
 */
export type AttentionWorkspaceState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'folderWorkspaces'
  | 'migrationUnsupportedByPtyId'
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
>

/**
 * Whether one hook row reads as waiting on the user, by the same rule the dashboard's
 * `attention` bucket uses.
 *
 * Only freshness matters here, not the decay destination: `worktree-agent-rows` decays a stale
 * `blocked`/`waiting` row through `resolveDecayedAgentRowState`, which can only return
 * `unverifiable` or `idle` — and `dashboardBucketForDotState` maps both away from `attention`.
 * So a stale row is never attention, and a fresh one keeps its own state.
 */
function isAttentionEntry(entry: AgentStatusEntry, now: number): boolean {
  if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
    return false
  }
  return entry.state === 'blocked' || entry.state === 'waiting'
}

type TabEntryIndex = {
  byTabId: Map<string, AgentStatusEntry[]>
  /** Entries carrying a workspace stamp, for rows whose tab this renderer never mirrored. */
  attributed: AgentStatusEntry[]
}

function indexAgentStatusEntries(state: AttentionWorkspaceState): TabEntryIndex {
  const byTabId = new Map<string, AgentStatusEntry[]>()
  const attributed: AgentStatusEntry[] = []
  const add = (entry: AgentStatusEntry): void => {
    const parsed = parsePaneKey(entry.paneKey)
    if (!parsed) {
      return
    }
    const bucket = byTabId.get(parsed.tabId)
    if (bucket) {
      bucket.push(entry)
    } else {
      byTabId.set(parsed.tabId, [entry])
    }
    if (entry.worktreeId) {
      attributed.push(entry)
    }
  }
  for (const entry of Object.values(state.agentStatusByPaneKey ?? {})) {
    add(entry)
  }
  // Why: an unsupported-migration row is published as `blocked`, so it is attention like any other.
  for (const unsupported of Object.values(state.migrationUnsupportedByPtyId ?? {})) {
    const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
    if (entry) {
      add(entry)
    }
  }
  return { byTabId, attributed }
}

function titleReadsAsWaiting(title: string): boolean {
  const status = classifyTitleActivity(title)
  return status !== null && titleStatusToRowState(status) === 'waiting'
}

function sortLiveSlotsFirst(entries: [string, string][]): [string, string][] {
  return entries.toSorted(([a], [b]) => {
    const paneIdA = Number(a)
    const paneIdB = Number(b)
    const isLiveA = paneIdA >= FIRST_PANE_ID
    return isLiveA !== paneIdB >= FIRST_PANE_ID ? (isLiveA ? -1 : 1) : paneIdA - paneIdB
  })
}

/** Whether any pane of one tab waits on the user. */
function tabHasAttention(
  tab: Pick<TerminalTab, 'id' | 'title'>,
  state: AttentionWorkspaceState,
  index: TabEntryIndex,
  now: number
): boolean {
  const entries = index.byTabId.get(tab.id) ?? []
  const hasLivePty = tabHasLivePty(state.ptyIdsByTabId, tab.id)
  // Leaves a fresh hook covers skip the title fallback, so one pane is never counted twice.
  const coveredLeafIds = new Set<string>()
  // Why a second set: a stale hook still owns the one-shot permission title it painted, so
  // letting the title through would leave the badge lit forever. Matches smart-attention.
  const permissionCoveredLeafIds = new Set<string>()
  for (const entry of entries) {
    if (isAttentionEntry(entry, now)) {
      return true
    }
    const leafId = parsePaneKey(entry.paneKey)?.leafId
    if (!leafId) {
      continue
    }
    permissionCoveredLeafIds.add(leafId)
    // Why restoredUnconfirmed: a hydrated row is never "fresh", yet it owns the title restored
    // alongside it — without this the tab-title fallback below would re-assert a prompt the
    // dashboard already suppressed. Same carve-out as smart-attention.
    if (
      entry.restoredUnconfirmed === true ||
      isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
    ) {
      coveredLeafIds.add(leafId)
    }
  }
  // Why: runtimePaneTitlesByTabId survives sleep, so a slept tab's stale title would leak in.
  if (!hasLivePty) {
    return false
  }
  const layout = state.terminalLayoutsByTabId?.[tab.id]
  const paneTitles = state.runtimePaneTitlesByTabId[tab.id]
  const paneTitleEntries = paneTitles ? Object.entries(paneTitles) : []

  if (paneTitleEntries.length === 0) {
    // Why: runtime pane titles only exist once an OSC frame lands, so a restored-but-unvisited
    // tab exposes its prompt through the persisted tab title alone.
    const leafId = layout?.activeLeafId ?? collectLeafIds(layout?.root ?? null)[0]
    if (!leafId) {
      return false
    }
    const covered = isSyntheticAgentPermissionTitle(tab.title)
      ? permissionCoveredLeafIds
      : coveredLeafIds
    return !covered.has(leafId) && titleReadsAsWaiting(tab.title)
  }

  // Why live slots first: a parked tab mints `-(leafIndex + 1)` copies of its titles, and once the
  // tab is live again the live slot is authoritative for that leaf. Same rule as the dashboard.
  const sortedEntries = sortLiveSlotsFirst(paneTitleEntries)
  const resolveLeafId = createTitleFallbackLeafResolver(
    layout,
    state.ptyIdsByTabId[tab.id] ?? [],
    sortedEntries,
    // Why: a guessed leaf would let a sibling's hook silence this pane's prompt.
    false
  )
  const liveTitledLeafIds = new Set<string>()
  for (const [runtimePaneId, title] of sortedEntries) {
    const paneId = Number(runtimePaneId)
    const isParkedSlot = paneId < FIRST_PANE_ID
    const leafId = resolveLeafId(paneId, title)
    if (leafId !== null) {
      if (isParkedSlot && liveTitledLeafIds.has(leafId)) {
        continue
      }
      if (!isParkedSlot) {
        liveTitledLeafIds.add(leafId)
      }
    }
    const covered = isSyntheticAgentPermissionTitle(title)
      ? permissionCoveredLeafIds
      : coveredLeafIds
    // Why the unmapped case: with one live PTY a lone title is the lone hook's pane even when
    // replay order cannot prove it; with more, the title may be a sibling's, so it stays counted.
    const hasSingleUnmappedHook =
      leafId === null &&
      covered.size === 1 &&
      paneTitleEntries.length === 1 &&
      (state.ptyIdsByTabId[tab.id]?.length ?? 0) <= 1
    if ((leafId !== null && covered.has(leafId)) || hasSingleUnmappedHook) {
      continue
    }
    if (titleReadsAsWaiting(title)) {
      return true
    }
  }
  return false
}

/**
 * Workspaces holding an agent that waits on the user, keyed as `resolveAttentionWorkspaceKeys`
 * keys them so a header can tell twins of one repo on two hosts apart.
 *
 * Iterates agents and panes rather than workspaces: a workspace with neither can never be
 * attention, so the cost tracks running agents, not installation size.
 *
 * One divergence from the dashboard is accepted: a permission-reading pane title whose agent
 * identity cannot be resolved produces no dashboard row but is counted here. Erring toward
 * showing the badge keeps a real prompt from going unnoticed, and expanding the group reveals it.
 */
export function buildAttentionWorkspaceIds(
  state: AttentionWorkspaceState,
  now: number
): ReadonlySet<string> {
  const index = indexAgentStatusEntries(state)
  const attentionTabs = new Map<string, (string | null)[]>()
  const mirroredTabIds = new Set<string>()
  const addAttention = (workspaceId: string, tabId: string | null): void => {
    const tabIds = attentionTabs.get(workspaceId)
    if (tabIds) {
      tabIds.push(tabId)
    } else {
      attentionTabs.set(workspaceId, [tabId])
    }
  }

  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      mirroredTabIds.add(tab.id)
      if (tabHasAttention(tab, state, index, now)) {
        addAttention(worktreeId, tab.id)
      }
    }
  }

  // Why: main can stamp a workspace onto a row before its tab reaches this renderer; once the
  // tab is mirrored the loop above owns the verdict, so only unmirrored rows are added here.
  for (const entry of index.attributed) {
    const parsed = parsePaneKey(entry.paneKey)
    if (!parsed || mirroredTabIds.has(parsed.tabId) || !entry.worktreeId) {
      continue
    }
    if (isAttentionEntry(entry, now)) {
      addAttention(entry.worktreeId, null)
    }
  }

  return resolveAttentionWorkspaceKeys(attentionTabs, state)
}
