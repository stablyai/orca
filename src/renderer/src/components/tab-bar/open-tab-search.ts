// Merges the three Cmd+J open-tab engines into one ranked list for the new-tab
// omnibox. Pure: no store, no React.

import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import {
  comparePaletteDocumentRank,
  type PaletteDocumentRank
} from '@/lib/palette-match/palette-document'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  searchBrowserPages,
  type BrowserPaletteSearchResult,
  type SearchableBrowserPage
} from '@/lib/browser-palette-search'
import {
  searchSimulatorTabs,
  type SearchableSimulatorTab,
  type SimulatorPaletteSearchResult
} from '@/lib/simulator-palette-search'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  searchWorkspaceTabs,
  type SearchableWorkspaceTab,
  type WorkspaceTabContentType,
  type WorkspaceTabPaletteSearchResult
} from '@/lib/workspace-tab-palette-search'

export const OPEN_TAB_SEARCH_RESULT_LIMIT = 4

// Why its own guard: searchWorkspaceTabs has no size limit of its own.
export const OPEN_TAB_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export type OpenTabSearchSource = 'workspace' | 'browser' | 'simulator'

type OpenTabSearchResultBase = {
  executionHostId: ExecutionHostId
  /** Stable across renders, so selection survives the deferred query. */
  id: string
  title: string
  /** Engine secondary text when the match came from a secondary field. */
  matchedText: string | null
  worktreeId: string
}

export type OpenTabSearchResult =
  | (OpenTabSearchResultBase & {
      source: 'workspace'
      contentType: WorkspaceTabContentType
      tabId: string
      entityId: string
      groupId: string
      relativePath: string | null
      occupantAgent: TuiAgent | null
    })
  | (OpenTabSearchResultBase & {
      source: 'browser'
      contentType: 'browser'
      pageId: string
      workspaceId: string
      url: string
      faviconUrl: string | null
    })
  | (OpenTabSearchResultBase & {
      source: 'simulator'
      contentType: 'simulator'
      tabId: string
      groupId: string
    })

export type OpenTabSearchInput = {
  workspaceTabs: readonly SearchableWorkspaceTab[]
  browserPages: readonly SearchableBrowserPage[]
  simulatorTabs: readonly SearchableSimulatorTab[]
  query: string
}

type RankedResult = {
  result: OpenTabSearchResult
  tier: number
  sourceRank: number
  matchRank: PaletteDocumentRank | null
  score: number
}

const SOURCE_RANK: Record<OpenTabSearchSource, number> = {
  workspace: 0,
  browser: 1,
  simulator: 2
}

const TITLE_PREFIX_TIER = 0
const TITLE_SUBSTRING_TIER = 1
// Why one tier for every secondary match: path and agent-snippet matches share
// `secondaryRanges`, so splitting on offset would outrank the engine's own match
// rank, which is compared explicitly below. See the plan's tiering decision.
const SECONDARY_TIER = 2

function isOpenTabSearchQueryTooLarge(
  query: string,
  maxBytes = OPEN_TAB_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

type EngineResult =
  | WorkspaceTabPaletteSearchResult
  | BrowserPaletteSearchResult
  | SimulatorPaletteSearchResult

// Why the positive signal rather than "no title and no secondary range": the
// simulator alias branch and the browser workspace-label branch are real matches
// that carry neither range, and would be dropped by the inverse test.
function isNameOnlyMatch(result: EngineResult): boolean {
  return result.worktreeRanges.length > 0 || result.repoRanges.length > 0
}

function getTier(result: EngineResult): number {
  const titleRange = result.titleRanges[0]
  if (!titleRange) {
    return SECONDARY_TIER
  }
  return titleRange.start === 0 ? TITLE_PREFIX_TIER : TITLE_SUBSTRING_TIER
}

function getMatchedText(result: EngineResult): string | null {
  return result.secondaryRanges.length > 0 ? result.secondaryText : null
}

// Why read the path off the entry: the engine overwrites `secondaryText` with
// whichever string matched, and an absolute-path match leaves no relative path.
// Why editor-only: diff and review tabs also carry a path, but they are not the
// same destination as opening the file, so they must not suppress its row.
function getEditorRelativePath(entry: SearchableWorkspaceTab | undefined): string | null {
  if (!entry || entry.tab.contentType !== 'editor') {
    return null
  }
  return entry.secondaryText || null
}

function baseResult(
  source: OpenTabSearchSource,
  id: string,
  result: EngineResult,
  executionHostId: ExecutionHostId
): OpenTabSearchResultBase {
  return {
    executionHostId,
    id: `open-tab:${source}:${id}`,
    title: result.title,
    matchedText: getMatchedText(result),
    worktreeId: result.worktreeId
  }
}

function rank<TEngine extends EngineResult>(
  source: OpenTabSearchSource,
  results: readonly TEngine[],
  toResult: (result: TEngine) => OpenTabSearchResult
): RankedResult[] {
  return results
    .filter((result) => !isNameOnlyMatch(result))
    .map((result) => ({
      tier: getTier(result),
      sourceRank: SOURCE_RANK[source],
      matchRank: result.rank,
      score: result.score,
      result: toResult(result)
    }))
}

export function searchOpenTabs({
  workspaceTabs,
  browserPages,
  simulatorTabs,
  query
}: OpenTabSearchInput): OpenTabSearchResult[] {
  const trimmed = query.trim()
  if (!trimmed || isOpenTabSearchQueryTooLarge(query)) {
    return []
  }

  // Single-worktree builders stamp one host on every entry; resolve once.
  const executionHostId =
    workspaceTabs[0]?.worktree.hostId ??
    browserPages[0]?.worktree.hostId ??
    simulatorTabs[0]?.worktree.hostId ??
    LOCAL_EXECUTION_HOST_ID
  // Why map workspace only: editor relativePath is read from the searchable entry.
  const workspaceEntriesByTabId = new Map(workspaceTabs.map((entry) => [entry.tab.id, entry]))

  return [
    // Why no isCurrentTab filter: Cmd+J lists the tab you are on, and hiding it
    // made the omnibox look broken when you searched for the tab on screen.
    ...rank('workspace', searchWorkspaceTabs([...workspaceTabs], trimmed), (result) => ({
      ...baseResult('workspace', result.tabId, result, executionHostId),
      source: 'workspace',
      contentType: result.contentType,
      tabId: result.tabId,
      entityId: result.entityId,
      groupId: result.groupId,
      relativePath: getEditorRelativePath(workspaceEntriesByTabId.get(result.tabId)),
      occupantAgent: result.occupantAgent
    })),
    ...rank('browser', searchBrowserPages([...browserPages], trimmed), (result) => ({
      ...baseResult('browser', result.pageId, result, executionHostId),
      source: 'browser',
      contentType: 'browser',
      pageId: result.pageId,
      workspaceId: result.workspaceId,
      url: result.url,
      faviconUrl: result.faviconUrl
    })),
    ...rank('simulator', searchSimulatorTabs([...simulatorTabs], trimmed), (result) => ({
      ...baseResult('simulator', result.tabId, result, executionHostId),
      source: 'simulator',
      contentType: 'simulator',
      tabId: result.tabId,
      groupId: result.groupId
    }))
  ]
    .sort((a, b) => {
      if (a.tier !== b.tier) {
        return a.tier - b.tier
      }
      if (a.sourceRank !== b.sourceRank) {
        return a.sourceRank - b.sourceRank
      }
      // Why before position: `score` is position-only now, so without this an
      // agent-snippet fallback in an earlier tab would outrank a real path match.
      if (a.matchRank && b.matchRank) {
        const byMatch = comparePaletteDocumentRank(a.matchRank, b.matchRank)
        if (byMatch !== 0) {
          return byMatch
        }
      }
      return a.score - b.score
    })
    .slice(0, OPEN_TAB_SEARCH_RESULT_LIMIT)
    .map((ranked) => ranked.result)
}
