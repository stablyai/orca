// Why: this is the pure filter/group/query core for Agent Session History.
// It lives in /shared (not renderer) so the mobile package can reuse it —
// Metro only watches mobile/ + repo-root src/shared, never src/renderer.
// INVARIANT: /shared is a leaf — this module must NOT import from src/renderer.
import type {
  AiVaultAgent,
  AiVaultScope,
  AiVaultSession,
  AiVaultSessionHost,
  AiVaultSort,
  AiVaultTimeRange
} from './ai-vault-types'
import type { AiVaultSessionSearchIndex, AiVaultIndexQueryMode } from './ai-vault-session-index'
import {
  agentLabel,
  folderGroupKey,
  folderLabel,
  groupAiVaultSessions,
  type AiVaultSessionGroup,
  type AiVaultSessionProject
} from './ai-vault-session-groups'
import {
  createAiVaultWorkspaceMatcher,
  indexedSessionHaystack,
  matchesSearchScopeTerms,
  matchesSessionDimensions,
  sessionCardHaystack,
  sessionRepoLabel,
  sessionSortTime
} from './ai-vault-session-filter-match'
import {
  AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES,
  isAiVaultSessionFilterQueryTooLarge,
  parseVaultQuery,
  timeRangeStartMs
} from './ai-vault-session-query'
import {
  DEFAULT_AI_VAULT_SEARCH_SCOPE,
  isAiVaultRgSearchScope,
  type AiVaultSearchScope
} from './ai-vault-session-search-scope'

export type { AiVaultSessionGroup, AiVaultSessionProject }
export {
  AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES,
  agentLabel,
  folderGroupKey,
  folderLabel,
  groupAiVaultSessions,
  isAiVaultSessionFilterQueryTooLarge,
  parseVaultQuery
}

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

export function filterAiVaultSessions(
  sessions: readonly AiVaultSession[],
  filters: AiVaultSessionFilterState,
  options: AiVaultSessionFilterOptions = {}
): AiVaultSession[] {
  if (isAiVaultSessionFilterQueryTooLarge(filters.query)) {
    return []
  }

  const parsedQuery = parseVaultQuery(filters.query)
  const termMode = options.termMode ?? 'and'
  const queryTerms = options.queryTerms ?? parsedQuery.terms
  const explicitSearchScope = filters.searchScope
  const searchScope = explicitSearchScope ?? DEFAULT_AI_VAULT_SEARCH_SCOPE
  // Why: mobile and other card-only callers omit searchScope. An unset scope
  // must keep metadata terms; only an explicit rg scope defers them to rg/FTS.
  const applyCardTerms =
    options.forceCardTerms === true ||
    explicitSearchScope === undefined ||
    !isAiVaultRgSearchScope(explicitSearchScope)
  // Why: an ephemeral index always reads previews and re-parses timestamps.
  // Empty / repo: / path: queries must stay on the hoisted session walk.
  const index = options.index
  const candidateIds = index && applyCardTerms ? index.query(queryTerms, termMode) : null
  const agentSet = new Set(filters.agents)
  const hostSet = new Set(filters.hosts ?? [])
  const rangeStartMs = timeRangeStartMs(filters.timeRange ?? 'all', options.nowMs ?? Date.now())
  const workspaceMatchers =
    filters.scope === 'workspace'
      ? filters.activeWorktreePaths.map(createAiVaultWorkspaceMatcher)
      : []

  const matches: AiVaultSession[] = []
  for (const session of sessions) {
    if (candidateIds && !candidateIds.has(session.id)) {
      continue
    }
    const document = index?.get(session.id)
    if (index && !document) {
      continue
    }
    if (
      !matchesSessionDimensions(
        session,
        filters,
        parsedQuery,
        agentSet,
        hostSet,
        rangeStartMs,
        workspaceMatchers,
        document
      )
    ) {
      continue
    }
    if (
      queryTerms.length > 0 &&
      applyCardTerms &&
      !matchesSearchScopeTerms(
        document
          ? indexedSessionHaystack(document, searchScope)
          : sessionCardHaystack(session, searchScope, sessionRepoLabel(session, filters)),
        queryTerms,
        termMode,
        true
      )
    ) {
      continue
    }
    matches.push(session)
  }

  if (matches.length < 2) {
    return matches
  }
  return matches
    .map((session) => ({ session, time: sessionSortTime(session, filters.sort) }))
    .sort((left, right) => right.time - left.time)
    .map(({ session }) => session)
}
