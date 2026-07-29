// Why: this is the pure filter/group/query core for Agent Session History.
// It lives in /shared (not renderer) so the mobile package can reuse it —
// Metro only watches mobile/ + repo-root src/shared, never src/renderer.
// INVARIANT: /shared is a leaf — this module must NOT import from src/renderer.
import { isPathInsideOrEqual, normalizeRuntimePathSeparators } from './cross-platform-path'
import { isClipboardTextByteLengthOverLimit } from './clipboard-text'
import { parseWslUncPath } from './wsl-paths'
import type {
  AiVaultAgent,
  AiVaultGroup,
  AiVaultScope,
  AiVaultSession,
  AiVaultSort
} from './ai-vault-types'
import {
  aiVaultAgentLabel,
  isAiVaultSessionRecoverableEmpty,
  isAiVaultSessionResumableContent
} from './ai-vault-types'
import type { ExecutionHostId } from './execution-host'
import { sessionPreviewSearchText } from './ai-vault-session-display'

// Why: the plain project descriptor is relocated here (no runtime dep) so the
// filter-state type can reference it without dragging the renderer-located
// ai-vault-session-projects runtime logic into /shared.
export type AiVaultSessionProject = {
  kind: 'repo' | 'folder' | 'unknown'
  key: string
  label: string
  projectId?: string
  repoId?: string
  hostKey?: ExecutionHostId
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
}

export type AiVaultSessionGroup = {
  key: string
  label: string
  sessions: AiVaultSession[]
}

type ParsedQuery = {
  terms: string[]
  repoTerms: string[]
  pathTerms: string[]
}

export const AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES = 2 * 1024

export function isAiVaultSessionFilterQueryTooLarge(
  query: string,
  maxBytes = AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function filterAiVaultSessions(
  sessions: readonly AiVaultSession[],
  filters: AiVaultSessionFilterState
): AiVaultSession[] {
  if (isAiVaultSessionFilterQueryTooLarge(filters.query)) {
    return []
  }

  const agentSet = new Set(filters.agents)
  const parsedQuery = parseVaultQuery(filters.query)

  return sessions
    .filter((session) => {
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
      if (filters.scope === 'workspace') {
        const cwd = session.cwd
        if (
          !cwd ||
          !filters.activeWorktreePaths.some((pathValue) =>
            isAiVaultSessionInWorkspacePath(pathValue, cwd)
          )
        ) {
          return false
        }
      }
      if (filters.scope === 'project') {
        if (!filters.activeProjectKey) {
          return false
        }
        if (filters.sessionProjectById?.get(session.id)?.key !== filters.activeProjectKey) {
          return false
        }
      }
      return matchesQuery(session, parsedQuery, filters)
    })
    .sort((left, right) => compareSessions(left, right, filters.sort))
}

export function groupAiVaultSessions(
  sessions: readonly AiVaultSession[],
  group: AiVaultGroup,
  options: {
    sessionProjectById?: ReadonlyMap<string, AiVaultSessionProject>
    projectLabelByKey?: ReadonlyMap<string, string>
  } = {}
): AiVaultSessionGroup[] {
  const groups = new Map<string, AiVaultSessionGroup>()

  for (const session of sessions) {
    const { key, label } = getGroupIdentity(session, group, options)
    const existing = groups.get(key)
    if (existing) {
      existing.sessions.push(session)
    } else {
      groups.set(key, { key, label, sessions: [session] })
    }
  }

  return [...groups.values()]
}

export function folderLabel(pathValue: string | null): string {
  if (!pathValue) {
    return 'Unknown location'
  }
  const parts = normalizeRuntimePathSeparators(pathValue).split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts[0] ?? pathValue
}

export function agentLabel(agent: AiVaultAgent): string {
  return aiVaultAgentLabel(agent)
}

export function parseVaultQuery(query: string): ParsedQuery {
  const terms: string[] = []
  const repoTerms: string[] = []
  const pathTerms: string[] = []

  for (const rawToken of tokenizeQuery(query)) {
    const token = rawToken.toLowerCase()
    if (token.startsWith('repo:')) {
      const value = token.slice('repo:'.length)
      if (value) {
        repoTerms.push(value)
      }
      continue
    }
    if (token.startsWith('path:')) {
      const value = token.slice('path:'.length)
      if (value) {
        pathTerms.push(value)
      }
      continue
    }
    terms.push(token)
  }

  return { terms, repoTerms, pathTerms }
}

function matchesQuery(
  session: AiVaultSession,
  parsed: ParsedQuery,
  filters: Pick<AiVaultSessionFilterState, 'sessionProjectById' | 'projectLabelByKey'>
): boolean {
  const searchable = [
    session.title,
    session.sessionId,
    session.agent,
    session.branch,
    session.model,
    session.cwd,
    session.filePath,
    sessionPreviewSearchText(session)
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (parsed.terms.some((term) => !searchable.includes(term))) {
    return false
  }

  const sessionProject = filters.sessionProjectById?.get(session.id)
  const repoLabel = (
    sessionProject?.kind === 'repo'
      ? (filters.projectLabelByKey?.get(sessionProject.key) ?? sessionProject.label)
      : folderLabel(session.cwd)
  ).toLowerCase()
  if (parsed.repoTerms.some((term) => !repoLabel.includes(term))) {
    return false
  }

  const pathSearch = `${session.cwd ?? ''} ${session.filePath}`.toLowerCase()
  if (parsed.pathTerms.some((term) => !pathSearch.includes(term))) {
    return false
  }

  return true
}

function compareSessions(left: AiVaultSession, right: AiVaultSession, sort: AiVaultSort): number {
  const leftValue = sort === 'created' ? left.createdAt : left.updatedAt
  const rightValue = sort === 'created' ? right.createdAt : right.updatedAt
  const leftTime = Date.parse(leftValue ?? left.modifiedAt)
  const rightTime = Date.parse(rightValue ?? right.modifiedAt)
  return rightTime - leftTime
}

function getGroupIdentity(
  session: AiVaultSession,
  group: AiVaultGroup,
  options: {
    sessionProjectById?: ReadonlyMap<string, AiVaultSessionProject>
    projectLabelByKey?: ReadonlyMap<string, string>
  }
): Pick<AiVaultSessionGroup, 'key' | 'label'> {
  if (group === 'agent') {
    return { key: session.agent, label: agentLabel(session.agent) }
  }
  if (group === 'project') {
    const sessionProject = options.sessionProjectById?.get(session.id)
    if (sessionProject) {
      return {
        key: sessionProject.key,
        label:
          options.projectLabelByKey?.get(sessionProject.key) ||
          sessionProject.label ||
          folderLabel(session.cwd)
      }
    }
  }
  return { key: getFolderGroupKey(session.cwd), label: folderLabel(session.cwd) }
}

function getFolderGroupKey(pathValue: string | null): string {
  return pathValue ? normalizeRuntimePathSeparators(pathValue).toLowerCase() : 'unknown'
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

function tokenizeQuery(query: string): string[] {
  const tokens: string[] = []
  // Why: keep quoted operator values (repo:/path:) intact so labels and paths
  // containing spaces still match — e.g. path:"/Users/ada/My Project".
  const pattern = /(repo|path):"([^"]+)"|(repo|path):'([^']+)'|"([^"]+)"|'([^']+)'|(\S+)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(query)) !== null) {
    const operator = match[1] ?? match[3]
    const operatorValue = match[2] ?? match[4]
    if (operator && operatorValue?.trim()) {
      tokens.push(`${operator.toLowerCase()}:${operatorValue.trim()}`)
      continue
    }

    const token = match[5] ?? match[6] ?? match[7]
    if (token?.trim()) {
      tokens.push(token.trim())
    }
  }
  return tokens
}
