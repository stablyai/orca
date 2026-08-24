import { compareBaseSensitivityLocaleText } from './locale-text-collators'
import {
  comparePaletteTabResults,
  matchPaletteTabDocument,
  preparePaletteTabQuery,
  isPaletteTabQueryRejected
} from './palette-match/tab-match'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import { matchWorkspaceTabAgentSnippet } from './workspace-tab-agent-snippet-match'
import { maxAgentActivityAt } from './workspace-tab-agent-metadata'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { MatchRange } from './palette-match/normalized-text'
import type { PaletteDocumentRank } from './palette-match/palette-document'
import type { PaletteResultQualityClass } from './palette-match/match-quality'
import type { TuiAgent } from '../../../shared/tui-agent'
import { getUnifiedTabPaletteExecutionHostId } from './unified-tab-host-ownership'
import type {
  SearchableWorkspaceTab,
  WorkspaceTabContentType
} from './workspace-tab-palette-search'

const NO_RANGES: readonly MatchRange[] = []

export type WorkspaceTabPaletteSearchResult = {
  /** Worktree ids collide across hosts; activation must not resolve by id alone. */
  executionHostId?: ExecutionHostId
  tabId: string
  entityId: string
  worktreeId: string
  groupId: string
  contentType: WorkspaceTabContentType
  occupantAgent: TuiAgent | null
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
  /** Most recent activity for this tab, or null when nothing is known. */
  lastActiveAt: number | null
}

function compareText(a: string, b: string): number {
  return compareBaseSensitivityLocaleText(a, b)
}

function compareEmptyQueryResults(
  a: WorkspaceTabPaletteSearchResult,
  b: WorkspaceTabPaletteSearchResult
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

function positionScore(entry: SearchableWorkspaceTab): number {
  // Why: current tab, then current worktree, then rendered tab order.
  const base = entry.worktreeSortIndex * 100 + entry.groupSortIndex * 10 + entry.tabSortIndex
  if (entry.isCurrentTab) {
    return base - 4000
  }
  return entry.isCurrentWorktree ? base - 1000 : base
}

function resolveWorkspaceTabLastActiveAt(entry: SearchableWorkspaceTab): number | null {
  // Agent activity wins when present; then explicit tab focus; otherwise fall back to worktree.
  const candidate =
    maxAgentActivityAt(entry.agentMetadata) ??
    entry.tab.lastFocusedAt ??
    (entry.worktree.lastActivityAt || null)
  if (candidate == null) {
    return null
  }
  // Never report activity older than the tab itself (e.g. a stale worktree signal).
  return Math.max(candidate, entry.tab.createdAt)
}

function baseResult(entry: SearchableWorkspaceTab): WorkspaceTabPaletteSearchResult {
  const executionHostId = getUnifiedTabPaletteExecutionHostId(entry.tab, entry.worktree)
  return {
    ...(executionHostId ? { executionHostId } : {}),
    tabId: entry.tab.id,
    entityId: entry.tab.entityId,
    worktreeId: entry.worktree.id,
    groupId: entry.tab.groupId,
    contentType: entry.tab.contentType,
    occupantAgent: entry.occupantAgent,
    title: entry.title,
    secondaryText: entry.secondaryText,
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
    rank: null,
    lastActiveAt: resolveWorkspaceTabLastActiveAt(entry)
  }
}

function matchEntry(
  entry: SearchableWorkspaceTab,
  query: NonNullable<ReturnType<typeof preparePaletteTabQuery>>
): WorkspaceTabPaletteSearchResult | null {
  const match = matchPaletteTabDocument(entry.document, query)
  if (!match) {
    // Why kept separate: agent text is not part of the structured field set, so it
    // never contributes to token coverage — it only recovers a row nothing else found.
    const snippet = matchWorkspaceTabAgentSnippet(entry.agentMetadata, query)
    if (!snippet) {
      return null
    }
    return {
      ...baseResult(entry),
      secondaryText: snippet.text,
      secondaryRanges: snippet.ranges,
      qualityClass: 'fuzzy-evidence',
      rank: snippet.rank
    }
  }

  const secondaryText =
    match.secondary !== null
      ? (entry.secondarySearchTexts[match.secondary.index] ?? entry.secondaryText)
      : entry.secondaryText
  const alias =
    match.typeAlias !== null ? (entry.typeSearchAliases ?? [])[match.typeAlias.index] : undefined

  return {
    ...baseResult(entry),
    secondaryText,
    titleRanges: match.titleRanges,
    secondaryRanges: match.secondary?.ranges ?? NO_RANGES,
    repoRanges: match.repoRanges,
    worktreeRanges: match.worktreeRanges,
    branchRanges: match.branchRanges,
    // Ranges are into the alias string, not the row: the content icon explains the
    // hit, so nothing on the row is highlighted from them.
    typeAliasMatch: alias ? { text: alias, ranges: match.typeAlias?.ranges ?? NO_RANGES } : null,
    qualityClass: match.qualityClass,
    rank: match.rank
  }
}

export function searchWorkspaceTabs(
  entries: readonly SearchableWorkspaceTab[],
  query: string
): WorkspaceTabPaletteSearchResult[] {
  if (isPaletteTabQueryRejected(query)) {
    return []
  }
  const prepared = preparePaletteTabQuery(query)
  if (!prepared) {
    return entries.map((entry) => baseResult(entry)).sort(compareEmptyQueryResults)
  }

  const results: WorkspaceTabPaletteSearchResult[] = []
  for (const entry of entries) {
    const result = matchEntry(entry, prepared)
    if (result) {
      results.push(result)
    }
  }

  return results.sort((a, b) =>
    a.rank && b.rank
      ? comparePaletteTabResults(
          {
            rank: a.rank,
            positionScore: a.score,
            id: a.tabId,
            lastActiveAt: a.lastActiveAt ?? undefined
          },
          {
            rank: b.rank,
            positionScore: b.score,
            id: b.tabId,
            lastActiveAt: b.lastActiveAt ?? undefined
          }
        )
      : compareEmptyQueryResults(a, b)
  )
}
