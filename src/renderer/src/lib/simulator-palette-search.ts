import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab, TabGroup, WorkspaceVisibleTabType } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getPaletteWorktreeIdentity,
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree
} from './palette-repo-resolution'
import { getActiveSimulatorTabId } from './simulator-palette-active-tab'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import { compareBaseSensitivityLocaleText } from './locale-text-collators'
import {
  comparePaletteTabResults,
  isOmniboxPaletteTabFieldAllowed,
  matchPaletteTabDocument,
  preparePaletteTabQuery
} from './palette-match/tab-match'
import { buildPaletteTabDocument } from './palette-match/tab-document'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import type { MatchRange } from './palette-match/normalized-text'
import type { PaletteDocument, PaletteDocumentRank } from './palette-match/palette-document'
import type { PaletteResultQualityClass } from './palette-match/match-quality'
import {
  createPaletteSearchContext,
  encodePaletteIdentity,
  maxValidPaletteActivityTimestamp,
  preparePaletteActivity,
  type PaletteActivityRank,
  type PaletteSearchContext
} from './palette-match/palette-ranking'
import {
  findAmbiguousWorktreeIds,
  findDuplicateIds,
  getUnifiedTabPaletteExecutionHostId,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'

const NO_RANGES: readonly MatchRange[] = []

export type SearchableSimulatorTab = {
  tab: Tab
  worktree: Worktree
  repoName: string
  worktreeSortIndex: number
  isCurrentTab: boolean
  isCurrentWorktree: boolean
  /** Normalized field index, built once per entry rather than per keystroke. */
  document: PaletteDocument
}

export type SimulatorPaletteSearchResult = {
  /** Worktree ids collide across hosts; activation must not resolve by id alone. */
  executionHostId?: ExecutionHostId
  paletteIdentity: string
  tabId: string
  worktreeId: string
  groupId: string
  title: string
  secondaryText: string
  secondaryMatches: readonly { text: string; ranges: readonly MatchRange[] }[]
  repoName: string
  worktreeName: string
  branchName: string
  titleRanges: readonly MatchRange[]
  secondaryRanges: readonly MatchRange[]
  repoRanges: readonly MatchRange[]
  worktreeRanges: readonly MatchRange[]
  branchRanges: readonly MatchRange[]
  typeAliasMatch?: { text: string; ranges: readonly MatchRange[] } | null
  typeAliasMatches: readonly { text: string; ranges: readonly MatchRange[] }[]
  isCurrentTab: boolean
  isCurrentWorktree: boolean
  score: number
  qualityClass: PaletteResultQualityClass | null
  rank: PaletteDocumentRank | null
  lastActiveAt?: number | null
  activity: PaletteActivityRank
}

export const SIMULATOR_PALETTE_QUERY_MAX_BYTES = 2 * 1024

// Why search-only: the row icon already says "emulator"; a fixed secondary label
// crowds Cmd+J the same way "Terminal tab" did. Keep these strings matchable so
// typing "mobile" / "simulator" still finds emulator tabs.
export const SIMULATOR_TYPE_SEARCH_ALIASES = [
  'mobile emulator tab',
  'mobile emulator',
  'ios simulator',
  'emulator'
] as const

export function isSimulatorPaletteQueryTooLarge(
  query: string,
  maxBytes = SIMULATOR_PALETTE_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export type BuildSearchableSimulatorTabsOptions = {
  worktrees: readonly Worktree[]
  ownershipWorktrees?: readonly Pick<Worktree, 'id'>[]
  repoMap: ReadonlyMap<string, { displayName?: string | null }>
  repoMapByHostIdentity?: ReadonlyMap<string, { displayName?: string | null }>
  worktreeOrder: ReadonlyMap<string, number>
  unifiedTabsByWorktree: Record<string, readonly Tab[] | undefined>
  activeGroupIdByWorktree: Record<string, string | undefined>
  groupsByWorktree: Record<string, readonly TabGroup[] | undefined>
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  activeTabType: WorkspaceVisibleTabType
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

// Why: empty-query simulator ordering stays deterministic and context-first;
// lastActiveAt only breaks ties between equally-ranked query matches.
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
        // Why: simulator tabs are unified tabs; terminal activeTabId does not
        // identify the visible emulator tab after split-group activation.
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
      // Ranges are into the alias string, not the row: the icon explains the hit,
      // so nothing on the row is highlighted from them.
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
