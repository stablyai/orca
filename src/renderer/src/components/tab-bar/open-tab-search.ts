// Merges the three Cmd+J open-tab engines into one ranked list for the new-tab
// omnibox. Pure: no store, no React.

import { capPaletteSection } from '../cmd-j/palette-section-render-cap'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import type { PaletteDocumentRank } from '@/lib/palette-match/palette-document'
import {
  comparePaletteEntityRanks,
  createPaletteSearchContext,
  encodePaletteIdentity,
  type PaletteActivityRank,
  type PaletteSearchContext
} from '@/lib/palette-match/palette-ranking'
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
import { getUnifiedTabPaletteExecutionHostId } from '@/lib/unified-tab-host-ownership'
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
  matchedTexts?: readonly string[]
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
  context?: PaletteSearchContext
  retainedResultId?: string | null
}

type RankedResult = {
  result: OpenTabSearchResult
  matchRank: PaletteDocumentRank
  activity: PaletteActivityRank
  position: readonly [number, number]
  identity: string
}

const SOURCE_RANK: Record<OpenTabSearchSource, number> = {
  workspace: 0,
  browser: 1,
  simulator: 2
}

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
  result: EngineResult,
  executionHostId: ExecutionHostId
): OpenTabSearchResultBase {
  return {
    executionHostId,
    id: result.paletteIdentity,
    title: result.title,
    matchedText: getMatchedText(result),
    matchedTexts: result.secondaryMatches.map((match) => match.text).filter(Boolean),
    worktreeId: result.worktreeId
  }
}

function rank<TEngine extends EngineResult>(
  source: OpenTabSearchSource,
  results: readonly TEngine[],
  toResult: (result: TEngine) => OpenTabSearchResult
): RankedResult[] {
  return results.flatMap((result) => {
    if (!result.rank) {
      return []
    }
    const converted = toResult(result)
    return [
      {
        matchRank: result.rank,
        activity: result.activity,
        position: [SOURCE_RANK[source], result.score],
        result: converted,
        identity: converted.id
      }
    ]
  })
}

export function searchOpenTabCandidates({
  workspaceTabs,
  browserPages,
  simulatorTabs,
  query,
  context: suppliedContext
}: OpenTabSearchInput): OpenTabSearchResult[] {
  const trimmed = query.trim()
  if (!trimmed || isOpenTabSearchQueryTooLarge(query)) {
    return []
  }

  const context = suppliedContext ?? createPaletteSearchContext(Date.now())
  // Why map workspace only: editor relativePath is read from the searchable entry.
  const workspaceEntriesByIdentity = new Map(
    workspaceTabs.map((entry) => [
      encodePaletteIdentity([
        getUnifiedTabPaletteExecutionHostId(entry.tab, entry.worktree) ?? LOCAL_EXECUTION_HOST_ID,
        entry.worktree.id,
        entry.tab.id
      ]),
      entry
    ])
  )

  return [
    // Why no isCurrentTab filter: Cmd+J lists the tab you are on, and hiding it
    // made the omnibox look broken when you searched for the tab on screen.
    ...rank(
      'workspace',
      searchWorkspaceTabs([...workspaceTabs], trimmed, { context, fieldMode: 'omnibox' }),
      (result) => ({
        ...baseResult(result, result.executionHostId ?? LOCAL_EXECUTION_HOST_ID),
        source: 'workspace',
        contentType: result.contentType,
        tabId: result.tabId,
        entityId: result.entityId,
        groupId: result.groupId,
        relativePath: getEditorRelativePath(
          workspaceEntriesByIdentity.get(
            encodePaletteIdentity([
              result.executionHostId ?? LOCAL_EXECUTION_HOST_ID,
              result.worktreeId,
              result.tabId
            ])
          )
        ),
        occupantAgent: result.occupantAgent
      })
    ),
    ...rank(
      'browser',
      searchBrowserPages([...browserPages], trimmed, { context, fieldMode: 'omnibox' }),
      (result) => ({
        ...baseResult(result, result.executionHostId ?? LOCAL_EXECUTION_HOST_ID),
        source: 'browser',
        contentType: 'browser',
        pageId: result.pageId,
        workspaceId: result.workspaceId,
        url: result.url,
        faviconUrl: result.faviconUrl
      })
    ),
    ...rank(
      'simulator',
      searchSimulatorTabs([...simulatorTabs], trimmed, { context, fieldMode: 'omnibox' }),
      (result) => ({
        ...baseResult(result, result.executionHostId ?? LOCAL_EXECUTION_HOST_ID),
        source: 'simulator',
        contentType: 'simulator',
        tabId: result.tabId,
        groupId: result.groupId
      })
    )
  ]
    .sort((a, b) => {
      return comparePaletteEntityRanks(
        {
          rank: a.matchRank,
          activity: a.activity,
          position: a.position,
          identity: a.identity
        },
        {
          rank: b.matchRank,
          activity: b.activity,
          position: b.position,
          identity: b.identity
        }
      )
    })
    .map((ranked) => ranked.result)
}

export function searchOpenTabs(input: OpenTabSearchInput): OpenTabSearchResult[] {
  return capOpenTabSearchCandidates(searchOpenTabCandidates(input), input.retainedResultId)
}

export function capOpenTabSearchCandidates(
  candidates: readonly OpenTabSearchResult[],
  retainedResultId?: string | null
): OpenTabSearchResult[] {
  const capped = capPaletteSection(
    candidates,
    OPEN_TAB_SEARCH_RESULT_LIMIT,
    (result) => result.id === retainedResultId
  )
  return [...capped.visible]
}
