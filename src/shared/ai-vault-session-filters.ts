// Why: this is the pure filter/group/query core for Agent Session History.
// It lives in /shared (not renderer) so the mobile package can reuse it —
// Metro only watches mobile/ + repo-root src/shared, never src/renderer.
// INVARIANT: /shared is a leaf — this module must NOT import from src/renderer.
import { isPathInsideOrEqual } from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'
import type {
  AiVaultAgent,
  AiVaultScope,
  AiVaultSession,
  AiVaultSessionHost,
  AiVaultSort,
  AiVaultTimeRange
} from './ai-vault-types'
import {
  isAiVaultSessionRecoverableEmpty,
  isAiVaultSessionResumableContent
} from './ai-vault-types'
import {
  AiVaultSessionSearchIndex,
  parseSessionTimestampMs,
  type AiVaultIndexQueryMode,
  type AiVaultIndexedSession
} from './ai-vault-session-index'
import {
  agentLabel,
  folderGroupKey,
  folderLabel,
  groupAiVaultSessions,
  type AiVaultSessionGroup,
  type AiVaultSessionProject
} from './ai-vault-session-groups'
import {
  AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES,
  isAiVaultSessionFilterQueryTooLarge,
  parseVaultQuery,
  timeRangeStartMs,
  type ParsedVaultQuery
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
  const index = options.index ?? createEphemeralIndex(sessions, filters)
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
  const candidateIds = applyCardTerms ? index.query(queryTerms, termMode) : null
  const agentSet = new Set(filters.agents)
  const hostSet = new Set(filters.hosts ?? [])
  const rangeStartMs = timeRangeStartMs(filters.timeRange ?? 'all', options.nowMs ?? Date.now())
  const byId = new Map(sessions.map((session) => [session.id, session]))

  const matches: AiVaultSession[] = []
  for (const session of sessions) {
    if (candidateIds && !candidateIds.has(session.id)) {
      continue
    }
    const document = index.get(session.id)
    if (!document) {
      continue
    }
    if (
      !matchesIndexedSession(
        session,
        document,
        filters,
        parsedQuery,
        agentSet,
        hostSet,
        rangeStartMs
      )
    ) {
      continue
    }
    if (!matchesSearchScopeTerms(document, queryTerms, searchScope, termMode, applyCardTerms)) {
      continue
    }
    matches.push(byId.get(session.id) ?? session)
  }

  return matches.sort((left, right) => compareSessions(left, right, filters.sort))
}

function createEphemeralIndex(
  sessions: readonly AiVaultSession[],
  filters: Pick<AiVaultSessionFilterState, 'sessionProjectById' | 'projectLabelByKey'>
): AiVaultSessionSearchIndex {
  const index = new AiVaultSessionSearchIndex()
  index.sync(sessions, {
    sessionProjectById: filters.sessionProjectById,
    projectLabelByKey: filters.projectLabelByKey
  })
  return index
}

function matchesSearchScopeTerms(
  document: AiVaultIndexedSession,
  terms: readonly string[],
  searchScope: AiVaultSearchScope,
  termMode: AiVaultIndexQueryMode,
  applyCardTerms: boolean
): boolean {
  if (terms.length === 0) {
    return true
  }
  if (!applyCardTerms) {
    return true
  }
  const haystack =
    searchScope === 'title'
      ? document.titleSearchable
      : searchScope === 'summary'
        ? document.summarySearchable
        : document.searchable
  if (termMode === 'or') {
    return terms.some((term) => haystack.includes(term))
  }
  return terms.every((term) => haystack.includes(term))
}

function matchesIndexedSession(
  session: AiVaultSession,
  document: AiVaultIndexedSession,
  filters: AiVaultSessionFilterState,
  parsed: ParsedVaultQuery,
  agentSet: ReadonlySet<AiVaultAgent>,
  hostSet: ReadonlySet<AiVaultSessionHost>,
  rangeStartMs: number | null
): boolean {
  if (!agentSet.has(session.agent)) {
    return false
  }
  // Hide plain empty sessions, but keep sessions with resumable content
  // (some parsers only learn turns from previews, e.g. Grok) and zero-turn
  // sessions that still carry recoverable content (queued prompts /
  // subagent transcripts) so a lost conversation is surfaced distinctly.
  if (
    filters.hideEmptySessions &&
    !isAiVaultSessionResumableContent(session) &&
    !isAiVaultSessionRecoverableEmpty(session)
  ) {
    return false
  }
  if (hostSet.size > 0 && !hostSet.has(document.host)) {
    return false
  }
  if (rangeStartMs !== null && document.updatedAtMs < rangeStartMs) {
    return false
  }
  if (parsed.afterMs !== null && document.updatedAtMs < parsed.afterMs) {
    return false
  }
  if (parsed.beforeMs !== null && document.updatedAtMs > parsed.beforeMs) {
    return false
  }
  if (parsed.hostTerms.length > 0 && !parsed.hostTerms.includes(document.host)) {
    return false
  }
  if (parsed.modelTerms.some((term) => !document.model.includes(term))) {
    return false
  }
  if (parsed.branchTerms.some((term) => !document.branch.includes(term))) {
    return false
  }
  if (
    filters.scope === 'workspace' &&
    !matchesWorkspaceScope(session.cwd, filters.activeWorktreePaths)
  ) {
    return false
  }
  if (filters.scope === 'project') {
    if (!filters.activeProjectKey || document.projectKey !== filters.activeProjectKey) {
      return false
    }
  }
  if (parsed.repoTerms.some((term) => !document.repoLabel.includes(term))) {
    return false
  }
  const pathSearch = `${document.cwd} ${document.filePath}`.toLowerCase()
  if (parsed.pathTerms.some((term) => !pathSearch.includes(term))) {
    return false
  }
  return true
}

function matchesWorkspaceScope(
  cwd: string | null,
  activeWorktreePaths: readonly string[]
): boolean {
  if (!cwd) {
    return false
  }
  return activeWorktreePaths.some((pathValue) => isAiVaultSessionInWorkspacePath(pathValue, cwd))
}

function compareSessions(left: AiVaultSession, right: AiVaultSession, sort: AiVaultSort): number {
  const leftValue = sort === 'created' ? left.createdAt : left.updatedAt
  const rightValue = sort === 'created' ? right.createdAt : right.updatedAt
  return (
    parseSessionTimestampMs(rightValue, right.modifiedAt) -
    parseSessionTimestampMs(leftValue, left.modifiedAt)
  )
}

function isAiVaultSessionInWorkspacePath(workspacePath: string, sessionCwd: string): boolean {
  if (isPathInsideOrEqual(workspacePath, sessionCwd)) {
    return true
  }

  const workspaceWslPath = parseWslUncPath(workspacePath)
  if (!workspaceWslPath) {
    return false
  }

  // WSL agent transcripts record Linux cwd values even when Orca stores the
  // active worktree as a Windows UNC path.
  return isPathInsideOrEqual(workspaceWslPath.linuxPath, sessionCwd)
}
