import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { isPaletteCurrentWorktree, resolvePaletteRepoForWorktree } from './palette-repo-resolution'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import { compareBaseSensitivityLocaleText } from './locale-text-collators'
import {
  comparePaletteTabResults,
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
  tabId: string
  worktreeId: string
  groupId: string
  title: string
  secondaryText: string
  repoName: string
  worktreeName: string
  branchName: string
  titleRanges: readonly MatchRange[]
  secondaryRanges: readonly MatchRange[]
  repoRanges: readonly MatchRange[]
  worktreeRanges: readonly MatchRange[]
  branchRanges: readonly MatchRange[]
  typeAliasMatch?: { text: string; ranges: readonly MatchRange[] } | null
  isCurrentTab: boolean
  isCurrentWorktree: boolean
  score: number
  qualityClass: PaletteResultQualityClass | null
  rank: PaletteDocumentRank | null
}

type SimulatorPaletteActiveTabType = 'browser' | 'editor' | 'terminal' | 'simulator'

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
  repoMap: ReadonlyMap<string, { displayName?: string | null }>
  repoMapByHostIdentity?: ReadonlyMap<string, { displayName?: string | null }>
  worktreeOrder: ReadonlyMap<string, number>
  unifiedTabsByWorktree: Record<string, readonly Tab[] | undefined>
  activeGroupIdByWorktree: Record<string, string | undefined>
  groupsByWorktree: Record<string, readonly TabGroup[] | undefined>
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  activeTabType: SimulatorPaletteActiveTabType
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

// Why: simulator tabs follow browser-tab Cmd+J ordering — deterministic and
// context-first until Orca tracks per-tab recency for this surface.
function positionScore(entry: SearchableSimulatorTab): number {
  if (entry.isCurrentTab) {
    return entry.worktreeSortIndex * 100 - 4000
  }
  return entry.worktreeSortIndex * 100 - (entry.isCurrentWorktree ? 1000 : 0)
}

export function simulatorPaletteTabTitle(tab: Tab): string {
  return tab.label || 'Mobile Emulator'
}

function baseResult(entry: SearchableSimulatorTab): SimulatorPaletteSearchResult {
  return {
    executionHostId: entry.worktree.hostId,
    tabId: entry.tab.id,
    worktreeId: entry.worktree.id,
    groupId: entry.tab.groupId,
    title: simulatorPaletteTabTitle(entry.tab),
    // Why empty: the smartphone icon already says the type; a fixed label crowds the row.
    secondaryText: '',
    repoName: entry.repoName,
    // Why resolve: a cleared display name leaves the raw field undefined at runtime.
    worktreeName: resolveWorktreeDisplayName(entry.worktree),
    branchName: resolveWorktreeBranchLabel(entry.worktree),
    titleRanges: NO_RANGES,
    secondaryRanges: NO_RANGES,
    repoRanges: NO_RANGES,
    worktreeRanges: NO_RANGES,
    branchRanges: NO_RANGES,
    isCurrentTab: entry.isCurrentTab,
    isCurrentWorktree: entry.isCurrentWorktree,
    score: positionScore(entry),
    qualityClass: null,
    rank: null
  }
}

function getActiveUnifiedTabId({
  worktreeId,
  worktreeHostId,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType,
  activeGroupIdByWorktree,
  groupsByWorktree
}: Pick<
  BuildSearchableSimulatorTabsOptions,
  | 'activeGroupIdByWorktree'
  | 'activeTabType'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'groupsByWorktree'
> & {
  worktreeId: string
  worktreeHostId?: Worktree['hostId']
}): string | null {
  if (
    !isPaletteCurrentWorktree(
      { id: worktreeId, hostId: worktreeHostId },
      activeWorktreeId,
      activeWorkspaceExecutionHostId
    ) ||
    activeTabType !== 'simulator'
  ) {
    return null
  }
  const activeGroupId = activeGroupIdByWorktree[worktreeId]
  const activeGroup = activeGroupId
    ? (groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId)
    : undefined
  return activeGroup?.activeTabId ?? null
}

export function buildSearchableSimulatorTabs({
  worktrees,
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
  for (const worktree of worktrees) {
    const repoName =
      resolvePaletteRepoForWorktree(worktree, repoMap, repoMapByHostIdentity)?.displayName ?? ''
    const worktreeSortIndex =
      worktreeOrder.get(getWorktreeHostIdentity(worktree)) ??
      worktreeOrder.get(worktree.id) ??
      Number.MAX_SAFE_INTEGER
    const activeUnifiedTabId = getActiveUnifiedTabId({
      worktreeId: worktree.id,
      worktreeHostId: worktree.hostId,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      activeGroupIdByWorktree,
      groupsByWorktree
    })
    const tabs = unifiedTabsByWorktree[worktree.id] ?? []
    for (const tab of tabs) {
      if (tab.contentType !== 'simulator') {
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
  query: string
): SimulatorPaletteSearchResult[] {
  if (isSimulatorPaletteQueryTooLarge(query)) {
    return []
  }
  const prepared = preparePaletteTabQuery(query)
  if (!prepared) {
    return query.trim()
      ? []
      : entries.map((entry) => baseResult(entry)).sort(compareEmptyQueryResults)
  }

  const results: SimulatorPaletteSearchResult[] = []
  for (const entry of entries) {
    const match = matchPaletteTabDocument(entry.document, prepared)
    if (!match) {
      continue
    }
    const alias =
      match.typeAlias !== null ? SIMULATOR_TYPE_SEARCH_ALIASES[match.typeAlias.index] : undefined
    results.push({
      ...baseResult(entry),
      titleRanges: match.titleRanges,
      repoRanges: match.repoRanges,
      worktreeRanges: match.worktreeRanges,
      branchRanges: match.branchRanges,
      // Ranges are into the alias string, not the row: the icon explains the hit,
      // so nothing on the row is highlighted from them.
      typeAliasMatch: alias ? { text: alias, ranges: match.typeAlias?.ranges ?? NO_RANGES } : null,
      qualityClass: match.qualityClass,
      rank: match.rank
    })
  }

  return results.sort((a, b) =>
    a.rank && b.rank
      ? comparePaletteTabResults(
          { rank: a.rank, positionScore: a.score, id: a.tabId },
          { rank: b.rank, positionScore: b.score, id: b.tabId }
        )
      : compareEmptyQueryResults(a, b)
  )
}
