// Why: this is the pure filter/query core for Agent Session History.
// It lives in /shared (not renderer) so the mobile package can reuse it —
// Metro only watches mobile/ + repo-root src/shared, never src/renderer.
// INVARIANT: /shared is a leaf — this module must NOT import from src/renderer.
import { splitAiVaultSearchQuery } from './ai-vault-search-query-operators'
import type {
  AiVaultAgent,
  AiVaultScope,
  AiVaultSession,
  AiVaultSessionHost,
  AiVaultSort,
  AiVaultTimeRange
} from './ai-vault-types'
import {
  isAiVaultSessionFilterQueryTooLarge,
  parseVaultQuery as parseExtendedVaultQuery,
  timeRangeStartMs
} from './ai-vault-session-query'
import {
  createAiVaultWorkspaceMatcher,
  matchesSearchScopeTerms,
  matchesSessionDimensions,
  sessionCardHaystack,
  sessionRepoLabel,
  sessionSortTime
} from './ai-vault-session-filter-match'
import {
  DEFAULT_AI_VAULT_SEARCH_SCOPE,
  isAiVaultRgSearchScope,
  type AiVaultSearchScope
} from './ai-vault-session-search-scope'
import type { AiVaultIndexQueryMode, AiVaultSessionSearchIndex } from './ai-vault-session-index'
import { folderLabel, type AiVaultSessionProject } from './ai-vault-session-groups'

export {
  AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES,
  isAiVaultSessionFilterQueryTooLarge
} from './ai-vault-session-query'
export type { AiVaultSessionGroup, AiVaultSessionProject } from './ai-vault-session-groups'
export {
  agentLabel,
  folderGroupKey,
  folderLabel,
  groupAiVaultSessions
} from './ai-vault-session-groups'

export type AiVaultSessionFilterState = {
  query: string
  agents: readonly AiVaultAgent[]
  scope: AiVaultScope
  sort: AiVaultSort
  activeWorktreePaths: readonly string[]
  activeProjectKey?: string | null
  sessionProjectById?: ReadonlyMap<string, AiVaultSessionProject>
  projectLabelByKey?: ReadonlyMap<string, string>
  hideEmptySessions: boolean
  timeRange?: AiVaultTimeRange
  hosts?: readonly AiVaultSessionHost[]
  searchScope?: AiVaultSearchScope
}

export type AiVaultSessionFilterOptions = {
  index?: AiVaultSessionSearchIndex
  nowMs?: number
  termMode?: AiVaultIndexQueryMode
  queryTerms?: readonly string[]
  forceCardTerms?: boolean
}

const EXTRA_QUERY_OPERATOR = /^(model|branch|host|after|since|before|cwd):/i

export function filterAiVaultSessions(
  sessions: readonly AiVaultSession[],
  filters: AiVaultSessionFilterState,
  options: AiVaultSessionFilterOptions = {}
): AiVaultSession[] {
  if (isAiVaultSessionFilterQueryTooLarge(filters.query)) {
    return []
  }

  const agentSet = new Set(filters.agents)
  const hostSet = new Set(filters.hosts ?? [])
  const parsedQuery = parseVaultQuery(filters.query)
  const rangeStartMs = timeRangeStartMs(filters.timeRange ?? 'all', options.nowMs ?? Date.now())
  const explicitSearchScope = filters.searchScope
  const searchScope = explicitSearchScope ?? DEFAULT_AI_VAULT_SEARCH_SCOPE
  // Why: mobile and other card-only callers omit searchScope. An unset scope
  // must keep metadata terms; only an explicit rg scope defers them to rg/FTS.
  const applyCardTerms =
    options.forceCardTerms === true ||
    explicitSearchScope === undefined ||
    !isAiVaultRgSearchScope(explicitSearchScope)
  const workspaceMatchers =
    filters.scope === 'workspace'
      ? filters.activeWorktreePaths.map(createAiVaultWorkspaceMatcher)
      : []

  const filtered = sessions.filter((session) => {
    if (
      !matchesSessionDimensions(
        session,
        filters,
        parsedQuery,
        agentSet,
        hostSet,
        rangeStartMs,
        workspaceMatchers
      )
    ) {
      return false
    }
    // Why: repo:/path:-only queries already ran in matchesSessionDimensions.
    // Building the card haystack would read every preview for no extra work.
    if (!applyCardTerms || parsedQuery.terms.length === 0) {
      return true
    }
    return matchesSearchScopeTerms(
      sessionCardHaystack(session, searchScope, sessionRepoLabel(session, filters)),
      parsedQuery.terms,
      options.termMode ?? 'and',
      true
    )
  })
  if (filtered.length < 2) {
    return filtered
  }
  return filtered
    .map((session) => ({ session, time: sessionSortTime(session, filters.sort) }))
    .sort((left, right) => right.time - left.time)
    .map(({ session }) => session)
}

/**
 * One reading of `repo:` / `path:` for the whole product.
 *
 * Delegates to `splitAiVaultSearchQuery`, which the search index also plans
 * from, so a query cannot mean one thing in this list and another in the index.
 * The values come back folded because everything this file compares is folded;
 * the index keeps the unfolded form, which is why the split itself does not.
 */
export function parseVaultQuery(query: string): ReturnType<typeof parseExtendedVaultQuery> {
  const split = splitAiVaultSearchQuery(query)
  const fold = (values: readonly string[]): string[] => values.map((value) => value.toLowerCase())
  const extras = parseExtendedVaultQuery(query)
  return {
    terms: fold(split.terms).filter((term) => !EXTRA_QUERY_OPERATOR.test(term)),
    repoTerms: fold(split.repoTerms),
    pathTerms: fold(split.pathTerms),
    modelTerms: extras.modelTerms,
    branchTerms: extras.branchTerms,
    hostTerms: extras.hostTerms,
    afterMs: extras.afterMs,
    beforeMs: extras.beforeMs
  }
}

/** What `repo:` and `path:` are compared against for one session. */
export type AiVaultQueryOperatorTarget = {
  cwd: string | null
  filePath: string
  /**
   * What `repo:` matches. The panel passes a resolved project label when it has
   * one; everything else falls back to the last two path segments.
   */
  repoLabel?: string
}

/**
 * Whether one session satisfies every `repo:` and `path:` term.
 *
 * The single definition of what those operators mean. The search index applies
 * this over its retrieved rows rather than expressing it in SQL, because SQL
 * cannot: LIKE folds ASCII and nothing else, and `path:` searches the transcript
 * path as well as the working directory. Both keys are conjunctive, matching
 * the qualifier semantics the panel has always had.
 */
export function matchesAiVaultQueryOperators(
  target: AiVaultQueryOperatorTarget,
  operators: { repoTerms: readonly string[]; pathTerms: readonly string[] }
): boolean {
  if (operators.repoTerms.length > 0) {
    const repoLabel = (target.repoLabel ?? folderLabel(target.cwd)).toLowerCase()
    if (operators.repoTerms.some((term) => !repoLabel.includes(term.toLowerCase()))) {
      return false
    }
  }
  if (operators.pathTerms.length > 0) {
    const pathSearch = `${target.cwd ?? ''} ${target.filePath}`.toLowerCase()
    if (operators.pathTerms.some((term) => !pathSearch.includes(term.toLowerCase()))) {
      return false
    }
  }
  return true
}
