import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'
import type {
  AiVaultScope,
  AiVaultSession,
  AiVaultSessionHost,
  AiVaultSort
} from './ai-vault-types'
import {
  isAiVaultSessionRecoverableEmpty,
  isAiVaultSessionResumableContent
} from './ai-vault-types'
import type { AiVaultIndexQueryMode, AiVaultIndexedSession } from './ai-vault-session-index'
import { folderLabel, type AiVaultSessionProject } from './ai-vault-session-groups'
import { deriveAiVaultSessionHost } from './ai-vault-session-host'
import { sessionPreviewSearchText } from './ai-vault-session-preview-text'
import type { ParsedVaultQuery } from './ai-vault-session-query'
import type { AiVaultSearchScope } from './ai-vault-session-search-scope'

type SessionProjectMaps = {
  sessionProjectById?: ReadonlyMap<string, AiVaultSessionProject>
  projectLabelByKey?: ReadonlyMap<string, string>
}

type SessionDimensionFilters = SessionProjectMaps & {
  hideEmptySessions: boolean
  scope: AiVaultScope
  activeProjectKey?: string | null
}

export function createAiVaultWorkspaceMatcher(
  workspacePath: string
): (normalizedCwd: string) => boolean {
  const matches = createNormalizedPathInsideOrEqualMatcher(workspacePath)
  const workspaceWslPath = parseWslUncPath(workspacePath)
  if (!workspaceWslPath) {
    return matches
  }
  // WSL transcripts record Linux cwd even when the workspace uses a UNC path.
  const matchesLinux = createNormalizedPathInsideOrEqualMatcher(workspaceWslPath.linuxPath)
  return (cwd) => matches(cwd) || matchesLinux(cwd)
}

export function sessionSortTime(session: AiVaultSession, sort: AiVaultSort): number {
  const value = sort === 'created' ? session.createdAt : session.updatedAt
  return Date.parse(value ?? session.modifiedAt)
}

export function matchesSearchScopeTerms(
  haystack: string,
  terms: readonly string[],
  termMode: AiVaultIndexQueryMode,
  applyCardTerms: boolean
): boolean {
  if (terms.length === 0 || !applyCardTerms) {
    return true
  }
  if (termMode === 'or') {
    return terms.some((term) => haystack.includes(term))
  }
  return terms.every((term) => haystack.includes(term))
}

export function indexedSessionHaystack(
  document: AiVaultIndexedSession,
  searchScope: AiVaultSearchScope
): string {
  if (searchScope === 'title') {
    return document.titleSearchable
  }
  if (searchScope === 'summary') {
    return document.summarySearchable
  }
  return document.searchable
}

export function sessionCardHaystack(
  session: AiVaultSession,
  searchScope: AiVaultSearchScope,
  repoLabel: string
): string {
  if (searchScope === 'title') {
    return session.title.toLowerCase()
  }
  if (searchScope === 'summary') {
    return sessionPreviewSearchText(session).toLowerCase()
  }
  return [
    session.title,
    session.sessionId,
    session.agent,
    session.branch,
    session.model,
    session.cwd,
    session.filePath,
    sessionPreviewSearchText(session),
    repoLabel
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function sessionRepoLabel(session: AiVaultSession, filters: SessionProjectMaps): string {
  const sessionProject = filters.sessionProjectById?.get(session.id)
  return (
    sessionProject?.kind === 'repo'
      ? (filters.projectLabelByKey?.get(sessionProject.key) ?? sessionProject.label)
      : folderLabel(session.cwd)
  ).toLowerCase()
}

export function matchesSessionDimensions(
  session: AiVaultSession,
  filters: SessionDimensionFilters,
  parsed: ParsedVaultQuery,
  agentSet: ReadonlySet<AiVaultSession['agent']>,
  hostSet: ReadonlySet<AiVaultSessionHost>,
  rangeStartMs: number | null,
  workspaceMatchers: readonly ((normalizedCwd: string) => boolean)[],
  document?: AiVaultIndexedSession
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
  const host = document?.host ?? deriveAiVaultSessionHost(session)
  if (hostSet.size > 0 && !hostSet.has(host)) {
    return false
  }
  if (parsed.hostTerms.length > 0 && !parsed.hostTerms.includes(host)) {
    return false
  }
  if (!matchesSessionTimeBounds(session, parsed, rangeStartMs, document)) {
    return false
  }
  const model = document?.model ?? (session.model ?? '').toLowerCase()
  const branch = document?.branch ?? (session.branch ?? '').toLowerCase()
  if (parsed.modelTerms.some((term) => !model.includes(term))) {
    return false
  }
  if (parsed.branchTerms.some((term) => !branch.includes(term))) {
    return false
  }
  if (filters.scope === 'workspace') {
    const cwd = session.cwd
    const normalizedCwd = cwd ? normalizeRuntimePathForComparison(cwd) : null
    if (normalizedCwd === null || !workspaceMatchers.some((matches) => matches(normalizedCwd))) {
      return false
    }
  }
  const projectKey =
    document?.projectKey ?? filters.sessionProjectById?.get(session.id)?.key ?? null
  if (filters.scope === 'project') {
    if (!filters.activeProjectKey || projectKey !== filters.activeProjectKey) {
      return false
    }
  }
  if (
    parsed.repoTerms.length > 0 &&
    parsed.repoTerms.some(
      (term) => !(document?.repoLabel ?? sessionRepoLabel(session, filters)).includes(term)
    )
  ) {
    return false
  }
  if (parsed.pathTerms.length === 0) {
    return true
  }
  const pathSearch =
    `${document?.cwd ?? session.cwd ?? ''} ${document?.filePath ?? session.filePath}`.toLowerCase()
  return !parsed.pathTerms.some((term) => !pathSearch.includes(term))
}

function matchesSessionTimeBounds(
  session: AiVaultSession,
  parsed: ParsedVaultQuery,
  rangeStartMs: number | null,
  document?: AiVaultIndexedSession
): boolean {
  if (rangeStartMs === null && parsed.afterMs === null && parsed.beforeMs === null) {
    return true
  }
  const updatedAtMs = document?.updatedAtMs ?? Date.parse(session.updatedAt ?? session.modifiedAt)
  if (rangeStartMs !== null && updatedAtMs < rangeStartMs) {
    return false
  }
  if (parsed.afterMs !== null && updatedAtMs < parsed.afterMs) {
    return false
  }
  if (parsed.beforeMs !== null && updatedAtMs > parsed.beforeMs) {
    return false
  }
  return true
}
