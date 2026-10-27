import type { Tab } from '../../../shared/tab-types'
import {
  getPaletteWorktreeIdentity,
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree
} from './palette-repo-resolution'
import { getActiveSimulatorTabId } from './simulator-palette-active-tab'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import { compareBaseSensitivityLocaleText } from '../../../shared/locale-text-collators'
import {
  comparePaletteTabResults,
  isOmniboxPaletteTabFieldAllowed,
  matchPaletteTabDocument,
  preparePaletteTabQuery
} from '../../../shared/palette-match/tab-match'
import { buildPaletteTabDocument } from '../../../shared/palette-match/tab-document'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import type { MatchRange } from '../../../shared/palette-match/normalized-text'
import {
  createPaletteSearchContext,
  encodePaletteIdentity,
  maxValidPaletteActivityTimestamp,
  preparePaletteActivity,
  type PaletteSearchContext
} from '../../../shared/palette-match/palette-ranking'
import {
  findAmbiguousWorktreeIds,
  findDuplicateIds,
  getUnifiedTabPaletteExecutionHostId,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'
import type {
  BuildSearchableSimulatorTabsOptions,
  SearchableSimulatorTab,
  SimulatorPaletteSearchResult
} from './simulator-palette-search-types'

export type {
  BuildSearchableSimulatorTabsOptions,
  SearchableSimulatorTab,
  SimulatorPaletteSearchResult
} from './simulator-palette-search-types'

const NO_RANGES: readonly MatchRange[] = []

export const SIMULATOR_PALETTE_QUERY_MAX_BYTES = 2 * 1024

// Keep type aliases searchable but undisplayed; the icon already identifies emulator rows without redundant secondary text.
export const SIMULATOR_TYPE_SEARCH_ALIASES = [
  'mobile emulator tab',
  'mobile emulator',
  'ios simulator',
  'emulator'
] as const

function isSimulatorPaletteQueryTooLarge(
  query: string,
  maxBytes = SIMULATOR_PALETTE_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

function compareText(a: string, b: string): number {
  return compareBaseSensitivityLocaleText(a, b)
}

function compareEmptyQueryResults(
  a: SimulatorPaletteSearchResult,
  b: SimulatorPaletteSearchResult
): number {
  if (a.isCurrentTab !== b.isCurrentTab) {
    return a.isCurrentTab ? -1 : 1
  }
  if (a.isCurrentWorktree !== b.isCurrentWorktree) {
    return a.isCurrentWorktree ? -1 : 1
  }
  if (a.score !== b.score) {
    return a.score - b.score
  }
  const worktreeCmp = compareText(a.worktreeName, b.worktreeName)
  if (worktreeCmp !== 0) {
    return worktreeCmp
  }
  return compareText(a.title, b.title)
}

// Empty queries use deterministic context order; lastActiveAt only breaks equal-ranked match ties.
function positionScore(entry: SearchableSimulatorTab): number {
  if (entry.isCurrentTab) {
    return entry.worktreeSortIndex * 100 - 4000
  }
  return entry.worktreeSortIndex * 100 - (entry.isCurrentWorktree ? 1000 : 0)
}

export function simulatorPaletteTabTitle(tab: Tab): string {
  return tab.label || 'Mobile Emulator'
}

function baseResult(
  entry: SearchableSimulatorTab,
  context: PaletteSearchContext
): SimulatorPaletteSearchResult {
  const executionHostId = getUnifiedTabPaletteExecutionHostId(entry.tab, entry.worktree)
  const activity = preparePaletteActivity(
    maxValidPaletteActivityTimestamp([entry.tab.lastFocusedAt, entry.tab.createdAt]),
    context
  )
  return {
    ...(executionHostId ? { executionHostId } : {}),
    paletteIdentity: encodePaletteIdentity([
      'simulator-tab',
      executionHostId ?? '',
      entry.worktree.id,
      entry.tab.id
    ]),
    tabId: entry.tab.id,
    worktreeId: entry.worktree.id,
    groupId: entry.tab.groupId,
    title: simulatorPaletteTabTitle(entry.tab),
    // Why empty: the smartphone icon already says the type; a fixed label crowds the row.
    secondaryText: '',
    secondaryMatches: [],
    repoName: entry.repoName,
    // Why resolve: a cleared display name leaves the raw field undefined at runtime.
    worktreeName: resolveWorktreeDisplayName(entry.worktree),
    branchName: resolveWorktreeBranchLabel(entry.worktree),
    titleRanges: NO_RANGES,
    secondaryRanges: NO_RANGES,
    repoRanges: NO_RANGES,
    worktreeRanges: NO_RANGES,
    branchRanges: NO_RANGES,
    typeAliasMatches: [],
    isCurrentTab: entry.isCurrentTab,
    isCurrentWorktree: entry.isCurrentWorktree,
    score: positionScore(entry),
    qualityClass: null,
    rank: null,
    lastActiveAt: activity.timestamp || null,
    activity
  }
}

export function buildSearchableSimulatorTabs({
  worktrees,
  ownershipWorktrees,
  repoMap,
  repoMapByHostIdentity,
  worktreeOrder,
  unifiedTabsByWorktree,
  activeGroupIdByWorktree,
  groupsByWorktree,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType
}: BuildSearchableSimulatorTabsOptions): SearchableSimulatorTab[] {
  const entries: SearchableSimulatorTab[] = []
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(ownershipWorktrees ?? worktrees)
  for (const worktree of worktrees) {
    const repoName =
      resolvePaletteRepoForWorktree(worktree, repoMap, repoMapByHostIdentity)?.displayName ?? ''
    const worktreeSortIndex =
      worktreeOrder.get(getPaletteWorktreeIdentity(worktree)) ??
      worktreeOrder.get(worktree.id) ??
      Number.MAX_SAFE_INTEGER
    const activeUnifiedTabId = getActiveSimulatorTabId({
      worktreeId: worktree.id,
      worktreeHostId: worktree.hostId,
      worktreeRuntimeOwnerEnvironmentId: worktree.runtimeOwnerEnvironmentId,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      activeGroupId: activeGroupIdByWorktree[worktree.id],
      groups: groupsByWorktree[worktree.id]
    })
    const tabs = unifiedTabsByWorktree[worktree.id] ?? []
    const duplicateTabIds = findDuplicateIds(tabs)
    for (const tab of tabs) {
      if (
        duplicateTabIds.has(tab.id) ||
        tab.contentType !== 'simulator' ||
        !isUnifiedTabOwnedByWorktree(tab, worktree, ambiguousWorktreeIds)
      ) {
        continue
      }
      entries.push({
        tab,
        worktree,
        repoName,
        worktreeSortIndex,
        // Use unified tab selection; terminal activeTabId cannot identify split-group emulator activation.
        isCurrentTab: activeUnifiedTabId === tab.id,
        isCurrentWorktree: isPaletteCurrentWorktree(
          worktree,
          activeWorktreeId,
          activeWorkspaceExecutionHostId
        ),
        document: buildPaletteTabDocument({
          id: tab.id,
          title: simulatorPaletteTabTitle(tab),
          secondaryTexts: [],
          worktreeName: resolveWorktreeDisplayName(worktree),
          branch: resolveWorktreeBranchLabel(worktree),
          repoName,
          typeAliases: SIMULATOR_TYPE_SEARCH_ALIASES
        })
      })
    }
  }
  return entries
}

export function searchSimulatorTabs(
  entries: readonly SearchableSimulatorTab[],
  query: string,
  options: { context?: PaletteSearchContext; fieldMode?: 'all' | 'omnibox' } = {}
): SimulatorPaletteSearchResult[] {
  const context = options.context ?? createPaletteSearchContext(Date.now())
  if (isSimulatorPaletteQueryTooLarge(query)) {
    return []
  }
  const prepared = preparePaletteTabQuery(query)
  if (!prepared) {
    return query.trim()
      ? []
      : entries.map((entry) => baseResult(entry, context)).sort(compareEmptyQueryResults)
  }

  const results: SimulatorPaletteSearchResult[] = []
  for (const entry of entries) {
    const match = matchPaletteTabDocument(entry.document, prepared, {
      isFieldAllowed: options.fieldMode === 'omnibox' ? isOmniboxPaletteTabFieldAllowed : undefined
    })
    if (!match) {
      continue
    }
    const alias =
      match.typeAlias !== null ? SIMULATOR_TYPE_SEARCH_ALIASES[match.typeAlias.index] : undefined
    results.push({
      ...baseResult(entry, context),
      titleRanges: match.titleRanges,
      repoRanges: match.repoRanges,
      worktreeRanges: match.worktreeRanges,
      branchRanges: match.branchRanges,
      // Alias ranges index search-only text; the icon explains the match, so never highlight them on the row.
      typeAliasMatch: alias ? { text: alias, ranges: match.typeAlias?.ranges ?? NO_RANGES } : null,
      typeAliasMatches: match.typeAliasMatches.map((typeAlias) => ({
        text: SIMULATOR_TYPE_SEARCH_ALIASES[typeAlias.index] ?? '',
        ranges: typeAlias.ranges
      })),
      qualityClass: match.qualityClass,
      rank: match.rank
    })
  }

  return results.sort((a, b) =>
    a.rank && b.rank
      ? comparePaletteTabResults(
          {
            rank: a.rank,
            positionScore: a.score,
            identity: a.paletteIdentity,
            activity: a.activity
          },
          {
            rank: b.rank,
            positionScore: b.score,
            identity: b.paletteIdentity,
            activity: b.activity
          }
        )
      : compareEmptyQueryResults(a, b)
  )
}
