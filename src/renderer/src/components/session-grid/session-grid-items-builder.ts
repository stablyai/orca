import type { AppState } from '@/store/types'
import {
  resolveTerminalTabActivityStatus,
  resolveTerminalTabAttentionBadge,
  terminalTabActivityToAgentDotState,
  terminalTabHasUnreadActivity
} from '@/components/tab-bar/terminal-tab-activity-status'
import type {
  SessionGridFilter,
  SessionGridItem,
  SessionGridStateFilter
} from '../../../../shared/session-grid-types'
import { resolveRemoteExecutionHostKind } from '@/lib/workspace-execution-host'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { sessionGridBucket } from './session-grid-bucket'
import { resolveSessionGridCardLivePane } from './session-grid-card-live-pane'
import {
  commitSessionGridItemReuse,
  reuseSessionGridBucketCounts,
  reuseSessionGridFilterOptions,
  reuseSessionGridItem,
  reuseSessionGridItemList,
  type SessionGridItemReuseCache
} from './session-grid-item-reuse-cache'
import {
  sessionGridWorktreeLabel,
  unknownWorktreeLabel,
  type SessionGridWorktreeCatalog,
  type SessionGridWorktreeEntry
} from './session-grid-worktree-catalog'
import { translate } from '@/i18n/i18n'

export type SessionGridFilterOption = {
  id: string
  label: string
  count: number
}

/** Cards per state chip. Exactly what clicking that chip would show, hidden ones included only while revealing. */
export type SessionGridBucketCounts = Record<Exclude<SessionGridStateFilter, 'all'>, number>

/** The store slices the listing reads, as a Pick so a test can pass a partial store. */
export type SessionGridItemsState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'agentStatusByPaneKey'
  | 'agentStatusEpoch'
  | 'runtimePaneTitlesByTabId'
  | 'unreadTerminalTabs'
  | 'unreadAgentCompletionPanes'
  | 'sessionsGridFilter'
  | 'sessionsGridStateFilter'
  | 'sessionsGridTabOrder'
  | 'sessionsGridHiddenTabIds'
> & {
  /** `settings.tabAutoGenerateTitle`, resolved by the caller so the builder reads no settings tree. */
  generatedTitlesEnabled: boolean
  /** The page's momentary reveal mode. Local component state on purpose, so it is passed in, not read. */
  revealHidden: boolean
}

export type SessionGridListing = {
  /** Cards under the active filter, in display order. */
  items: SessionGridItem[]
  /** Every card in display order; the drag reorder works on this list, not the filtered one. */
  allItems: SessionGridItem[]
  filterOptions: SessionGridFilterOption[]
  /** The persisted filter, or 'all' when it names a workspace that no longer exists. */
  activeFilter: SessionGridFilter
  /** Per-bucket tallies for the state chips, under the workspace filter but not under the state one. */
  stateCounts: SessionGridBucketCounts
  activeStateFilter: SessionGridStateFilter
  /** Hidden cards in the current workspace scope, counted whether or not they are being revealed. */
  hiddenCount: number
}

// Why anchored to the word: no agent currently reports context usage through
// the tab title, and a bare `\d+%` matched any percentage in a task name —
// "contrato 21%" showed up as 21% of context, red badge included.
const CONTEXT_PERCENT_RE = /\bcontext\b[^\d%]{0,16}(\d{1,3})\s*%|\b(\d{1,3})\s*%\s*context\b/i

function extractContextPercent(title: string): number | undefined {
  const match = CONTEXT_PERCENT_RE.exec(title)
  const raw = match?.[1] ?? match?.[2]
  if (raw === undefined) {
    return undefined
  }
  const val = Number.parseInt(raw, 10)
  return Number.isFinite(val) && val >= 0 && val <= 100 ? val : undefined
}

/**
 * Where this card's session runs. The pty id is the authority — it embeds its owner —
 * and the workspace answers only for a card whose id names no host: parked, still
 * spawning, or a plain local pty. A malformed id ('foreign': off-host but unnameable)
 * falls back the same way, which is what the dashboard reports for it too.
 */
function resolveSessionGridItemHost(
  ptyId: string | null,
  entry: SessionGridWorktreeEntry | undefined,
  resolveHostLabel: SessionGridWorktreeCatalog['resolveHostLabel']
): Pick<SessionGridItem, 'hostKind' | 'executionHostId' | 'hostLabel'> {
  const ptyHost = getPtyExecutionHost(ptyId)
  if (ptyHost && ptyHost !== 'foreign') {
    return {
      // Never 'local': getPtyExecutionHost returns null, not a host, for an id that names none.
      hostKind: resolveRemoteExecutionHostKind(null, ptyHost) ?? 'local',
      executionHostId: ptyHost,
      hostLabel: resolveHostLabel(ptyHost)
    }
  }
  return {
    hostKind: entry?.hostKind ?? 'local',
    executionHostId: entry?.executionHostId ?? LOCAL_EXECUTION_HOST_ID,
    hostLabel: entry?.hostLabel
  }
}

function buildSessionGridItem(
  state: SessionGridItemsState,
  tab: TerminalTab,
  worktreeId: string,
  entry: SessionGridWorktreeEntry | undefined,
  hiddenTabIds: ReadonlySet<string>,
  resolveHostLabel: SessionGridWorktreeCatalog['resolveHostLabel']
): SessionGridItem {
  const terminalLayout = state.terminalLayoutsByTabId[tab.id]
  const { ptyId, paneKey } = resolveSessionGridCardLivePane(
    tab,
    terminalLayout,
    state.ptyIdsByTabId[tab.id] ?? []
  )
  const title = resolveTerminalTabTitle(
    tab,
    state.generatedTitlesEnabled,
    tab.defaultTitle?.trim() ||
      translate('auto.components.session.grid.session.grid.items.builder.5c39f0175d', 'Terminal')
  )
  // Why the intermediate status survives: the ladder takes the full activity vocabulary,
  // and `active`/`inactive` both collapse into the dot state's `idle`. Re-deriving the
  // badge from `dotState` agrees today by coincidence and breaks silently the day the
  // ladder tells those two apart.
  const status = resolveTerminalTabActivityStatus({
    tab,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    agentStatusEpoch: state.agentStatusEpoch,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    terminalLayout
  })
  const dotState = terminalTabActivityToAgentDotState(status) ?? 'idle'
  const hasUnread = terminalTabHasUnreadActivity({
    terminalTabId: tab.id,
    unreadTerminalTabs: state.unreadTerminalTabs,
    unreadAgentCompletionPanes: state.unreadAgentCompletionPanes
  })

  return {
    tabId: tab.id,
    ptyId,
    paneKey,
    worktreeId,
    repoId: entry?.repoId ?? worktreeId,
    repoName:
      entry?.repoName ??
      translate('auto.components.session.grid.session.grid.items.builder.6d07bd7ce3', 'Project'),
    worktreeName: entry?.worktreeName ?? unknownWorktreeLabel(),
    branch: entry?.branch,
    title,
    dotState,
    hasUnread,
    attentionBadge: resolveTerminalTabAttentionBadge({ status, hasUnread }),
    isHiddenFromGrid: hiddenTabIds.has(tab.id),
    contextPercent: extractContextPercent(title),
    createdAt: tab.createdAt,
    // Three scalars, spread from a fresh object the reuse cache never sees: a fresh
    // object AS A FIELD would cost every card its reuse. Both branches below write
    // `hostLabel` even when undefined, which is what keeps their `Object.keys().length`
    // equal — `reuseSessionGridItem` compares that count before any value.
    ...resolveSessionGridItemHost(ptyId, entry, resolveHostLabel),
    cwd: tab.startupCwd ?? entry?.path ?? '',
    shellOverride: tab.shellOverride,
    launchAgent: tab.launchAgent
  }
}

/** Manual drag order first, then chronological for anything the order does not name. */
function sortSessionGridItems(items: SessionGridItem[], tabOrder: readonly string[]): void {
  if (tabOrder.length === 0) {
    items.sort((a, b) => a.createdAt - b.createdAt)
    return
  }
  const orderMap = new Map(tabOrder.map((id, idx) => [id, idx]))
  items.sort((a, b) => {
    const idxA = orderMap.get(a.tabId)
    const idxB = orderMap.get(b.tabId)
    if (idxA !== undefined && idxB !== undefined) {
      return idxA - idxB
    }
    if (idxA !== undefined) {
      return -1
    }
    if (idxB !== undefined) {
      return 1
    }
    return a.createdAt - b.createdAt
  })
}

/**
 * Every session card in display order, plus the filter chips and the resolved
 * filter. Pure over the state slice it is handed, so it is testable without
 * mounting the hook.
 */
export function buildSessionGridListing(
  state: SessionGridItemsState,
  worktreeCatalog: SessionGridWorktreeCatalog,
  reuseCache?: SessionGridItemReuseCache
): SessionGridListing {
  const worktreeLookup = worktreeCatalog.byWorktreeId
  const hiddenTabIds = new Set(state.sessionsGridHiddenTabIds ?? [])
  const allItems: SessionGridItem[] = []
  const countsByWorktree = new Map<string, number>()
  let visibleTotal = 0

  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (!tabs || tabs.length === 0) {
      continue
    }
    const entry = worktreeLookup.get(worktreeId)
    let visibleInWorktree = 0
    for (const tab of tabs) {
      const item = buildSessionGridItem(
        state,
        tab,
        worktreeId,
        entry,
        hiddenTabIds,
        worktreeCatalog.resolveHostLabel
      )
      allItems.push(
        reuseCache ? reuseSessionGridItem(reuseCache.previousByTabId.get(tab.id), item) : item
      )
      if (state.revealHidden || !item.isHiddenFromGrid) {
        visibleInWorktree += 1
      }
    }
    visibleTotal += visibleInWorktree
    countsByWorktree.set(worktreeId, visibleInWorktree)
  }

  sortSessionGridItems(allItems, state.sessionsGridTabOrder ?? [])

  // Why resolve here and not at hydration: startup hydrates UI before the
  // workspace catalogs, so a validity check there would discard every
  // persisted filter. A filter naming a deleted workspace falls back to
  // 'all'; one naming a live workspace with no sessions stays, with a
  // zero-count chip, so closing the last session does not snap the view.
  const persistedFilter = state.sessionsGridFilter
  const activeFilter =
    persistedFilter === 'all' || worktreeLookup.has(persistedFilter) ? persistedFilter : 'all'
  if (activeFilter !== 'all' && !countsByWorktree.has(activeFilter)) {
    countsByWorktree.set(activeFilter, 0)
  }

  const filterOptions: SessionGridFilterOption[] = [
    {
      id: 'all',
      label: translate(
        'auto.components.session.grid.session.grid.items.builder.allWorkspaces',
        'All workspaces'
      ),
      count: visibleTotal
    }
  ]
  for (const [worktreeId, count] of countsByWorktree) {
    filterOptions.push({
      id: worktreeId,
      label: sessionGridWorktreeLabel(worktreeLookup.get(worktreeId)),
      count
    })
  }

  // Workspace, then state, then hidden. The first two are axes the user picks between,
  // so they are never crossed: a workspace chip counts the workspace whatever bucket is
  // selected, and vice versa, or the numbers would dance as the other axis moves.
  // Hidden is not an axis, it is a subtraction that always applies — so BOTH rows take
  // it off (unless the reveal mode is on), and every chip's number is exactly what
  // clicking it puts on screen. `hiddenCount` is what says the subtraction happened.
  //
  // And revealing is not a query on either axis, it is "show me what I put away", so a
  // revealed card comes back on top of whatever any lens selected. Deciding it the other way
  // — counting only the hidden cards the state chip would show — would have made
  // `hiddenCount` honest without giving the user any way to un-hide the rest from the grid.
  const activeStateFilter = state.sessionsGridStateFilter ?? 'all'
  const stateCounts: SessionGridBucketCounts = {
    attention: 0,
    working: 0,
    done: 0,
    idle: 0
  }
  const items: SessionGridItem[] = []
  let hiddenCount = 0
  for (const item of allItems) {
    if (activeFilter !== 'all' && item.worktreeId !== activeFilter) {
      continue
    }
    if (item.isHiddenFromGrid) {
      hiddenCount += 1
      if (!state.revealHidden) {
        continue
      }
    }
    const bucket = sessionGridBucket(item)
    stateCounts[bucket] += 1
    const passesStateFilter = activeStateFilter === 'all' || bucket === activeStateFilter
    if (passesStateFilter || item.isHiddenFromGrid) {
      items.push(item)
    }
  }

  if (!reuseCache) {
    return {
      items,
      allItems,
      filterOptions,
      activeFilter,
      stateCounts,
      activeStateFilter,
      hiddenCount
    }
  }

  // Why the arrays too: the page memoizes on them, so an unchanged list must not
  // hand a new array to the sortable context on every status tick. And why the chips
  // as well: the toolbar is memoized, and a fresh options array on every 33 ms burst
  // would defeat the memo just as surely as a fresh card would.
  const reusedAll = reuseSessionGridItemList(reuseCache.previousAllItems, allItems)
  const reused =
    items.length === allItems.length
      ? reusedAll
      : reuseSessionGridItemList(reuseCache.previousItems, items)
  commitSessionGridItemReuse(reuseCache, reusedAll, reused)
  return {
    items: reused,
    allItems: reusedAll,
    filterOptions: reuseSessionGridFilterOptions(reuseCache, filterOptions),
    activeFilter,
    stateCounts: reuseSessionGridBucketCounts(reuseCache, stateCounts),
    activeStateFilter,
    hiddenCount
  }
}
