import { ORCA_BROWSER_BLANK_URL } from '../../../shared/constants'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'
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
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { MatchRange } from './palette-match/normalized-text'
import type { PaletteDocument, PaletteDocumentRank } from './palette-match/palette-document'
import type { PaletteResultQualityClass } from './palette-match/match-quality'

const NO_RANGES: readonly MatchRange[] = []

export type SearchableBrowserPage = {
  page: BrowserPage
  workspace: BrowserWorkspace
  worktree: Worktree
  repoName: string
  worktreeSortIndex: number
  isCurrentPage: boolean
  isCurrentWorktree: boolean
  /** Normalized field index, built once per entry rather than per keystroke. */
  document: PaletteDocument
}

export type BrowserPaletteSearchResult = {
  /** Worktree ids collide across hosts; activation must not resolve by id alone. */
  executionHostId?: ExecutionHostId
  pageId: string
  workspaceId: string
  worktreeId: string
  title: string
  secondaryText: string
  workspaceLabel: string | null
  repoName: string
  worktreeName: string
  branchName: string
  workspaceRanges: readonly MatchRange[]
  titleRanges: readonly MatchRange[]
  secondaryRanges: readonly MatchRange[]
  repoRanges: readonly MatchRange[]
  worktreeRanges: readonly MatchRange[]
  branchRanges: readonly MatchRange[]
  isCurrentPage: boolean
  isCurrentWorktree: boolean
  score: number
  qualityClass: PaletteResultQualityClass | null
  rank: PaletteDocumentRank | null
}

export const BROWSER_PALETTE_QUERY_MAX_BYTES = 2 * 1024

export function isBrowserPaletteQueryTooLarge(
  query: string,
  maxBytes = BROWSER_PALETTE_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

function compareText(a: string, b: string): number {
  return compareBaseSensitivityLocaleText(a, b)
}

export function isBlankBrowserUrl(url: string): boolean {
  return url === 'about:blank' || url === ORCA_BROWSER_BLANK_URL
}

export function formatBrowserPaletteUrl(url: string): string {
  if (isBlankBrowserUrl(url)) {
    return 'New Tab'
  }
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

/** Ordered to match the row: the formatted URL is shown, the raw URL is a fallback. */
export function browserPaletteSecondaryTexts(page: BrowserPage): string[] {
  return [formatBrowserPaletteUrl(page.url), page.url]
}

export function buildSearchableBrowserPageDocument(args: {
  page: BrowserPage
  workspace: BrowserWorkspace
  worktree: Worktree
  repoName: string
}): PaletteDocument {
  return buildPaletteTabDocument({
    id: args.page.id,
    title: args.page.title || formatBrowserPaletteUrl(args.page.url),
    secondaryTexts: browserPaletteSecondaryTexts(args.page),
    worktreeName: resolveWorktreeDisplayName(args.worktree),
    branch: resolveWorktreeBranchLabel(args.worktree),
    repoName: args.repoName,
    // Why conditional on a label: an unlabeled workspace has nothing the row renders.
    workspaceLabel: args.workspace.label ?? ''
  })
}

function compareEmptyQueryResults(
  a: BrowserPaletteSearchResult,
  b: BrowserPaletteSearchResult
): number {
  if (a.isCurrentPage !== b.isCurrentPage) {
    return a.isCurrentPage ? -1 : 1
  }
  if (a.isCurrentWorktree !== b.isCurrentWorktree) {
    return a.isCurrentWorktree ? -1 : 1
  }
  if (a.score !== b.score) {
    return a.score - b.score
  }
  const secondaryCmp = compareText(a.secondaryText, b.secondaryText)
  if (secondaryCmp !== 0) {
    return secondaryCmp
  }
  return compareText(a.title, b.title)
}

// Why: empty-query browser ordering is intentionally deterministic and context-first.
// The palette should not invent hidden browser recency semantics.
function positionScore(entry: SearchableBrowserPage): number {
  if (entry.isCurrentPage) {
    return entry.worktreeSortIndex * 100 - 4000
  }
  return entry.worktreeSortIndex * 100 - (entry.isCurrentWorktree ? 1000 : 0)
}

function baseResult(entry: SearchableBrowserPage): BrowserPaletteSearchResult {
  const formattedUrl = formatBrowserPaletteUrl(entry.page.url)
  return {
    ...(entry.worktree.hostId ? { executionHostId: entry.worktree.hostId } : {}),
    pageId: entry.page.id,
    workspaceId: entry.workspace.id,
    worktreeId: entry.worktree.id,
    title: entry.page.title || formattedUrl,
    secondaryText: formattedUrl,
    workspaceLabel: entry.workspace.label ?? null,
    repoName: entry.repoName,
    // Why resolve: a cleared display name leaves the raw field undefined at runtime.
    worktreeName: resolveWorktreeDisplayName(entry.worktree),
    branchName: resolveWorktreeBranchLabel(entry.worktree),
    workspaceRanges: NO_RANGES,
    titleRanges: NO_RANGES,
    secondaryRanges: NO_RANGES,
    repoRanges: NO_RANGES,
    worktreeRanges: NO_RANGES,
    branchRanges: NO_RANGES,
    isCurrentPage: entry.isCurrentPage,
    isCurrentWorktree: entry.isCurrentWorktree,
    score: positionScore(entry),
    qualityClass: null,
    rank: null
  }
}

export function searchBrowserPages(
  entries: readonly SearchableBrowserPage[],
  query: string
): BrowserPaletteSearchResult[] {
  if (isBrowserPaletteQueryTooLarge(query)) {
    return []
  }
  const prepared = preparePaletteTabQuery(query)
  if (!prepared) {
    // Why not [] on an over-token query: the empty branch also serves the no-query
    // listing, so the invalid case is filtered out by the token guard below.
    return query.trim()
      ? []
      : entries.map((entry) => baseResult(entry)).sort(compareEmptyQueryResults)
  }

  const results: BrowserPaletteSearchResult[] = []
  for (const entry of entries) {
    const base = baseResult(entry)
    const secondaryTexts = browserPaletteSecondaryTexts(entry.page)
    const match = matchPaletteTabDocument(entry.document, prepared)
    if (!match) {
      continue
    }
    results.push({
      ...base,
      secondaryText:
        match.secondary !== null ? secondaryTexts[match.secondary.index] : base.secondaryText,
      workspaceRanges: match.workspaceRanges,
      titleRanges: match.titleRanges,
      secondaryRanges: match.secondary?.ranges ?? NO_RANGES,
      repoRanges: match.repoRanges,
      worktreeRanges: match.worktreeRanges,
      branchRanges: match.branchRanges,
      qualityClass: match.qualityClass,
      rank: match.rank
    })
  }

  return results.sort((a, b) =>
    a.rank && b.rank
      ? comparePaletteTabResults(
          { rank: a.rank, positionScore: a.score, id: a.pageId },
          { rank: b.rank, positionScore: b.score, id: b.pageId }
        )
      : compareEmptyQueryResults(a, b)
  )
}
