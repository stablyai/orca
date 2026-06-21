import {
  isPathInsideOrEqual,
  normalizeRuntimePathSeparators
} from '../../../../shared/cross-platform-path'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import type {
  AiVaultAgent,
  AiVaultGroup,
  AiVaultScope,
  AiVaultSession,
  AiVaultSort
} from '../../../../shared/ai-vault-types'
import { aiVaultAgentLabel } from '../../../../shared/ai-vault-types'
import { sessionPreviewSearchText } from './ai-vault-session-display'

export type AiVaultSessionFilterState = {
  query: string
  agents: readonly AiVaultAgent[]
  scope: AiVaultScope
  sort: AiVaultSort
  activeWorktreePath: string | null
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
      if (filters.hideEmptySessions && session.messageCount === 0) {
        return false
      }
      if (
        filters.scope === 'workspace' &&
        filters.activeWorktreePath &&
        (!session.cwd || !isPathInsideOrEqual(filters.activeWorktreePath, session.cwd))
      ) {
        return false
      }
      return matchesQuery(session, parsedQuery)
    })
    .sort((left, right) => compareSessions(left, right, filters.sort))
}

export function groupAiVaultSessions(
  sessions: readonly AiVaultSession[],
  group: AiVaultGroup
): AiVaultSessionGroup[] {
  const groups = new Map<string, AiVaultSessionGroup>()

  for (const session of sessions) {
    const key = group === 'agent' ? session.agent : getFolderGroupKey(session.cwd)
    const label = group === 'agent' ? agentLabel(session.agent) : folderLabel(session.cwd)
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

function matchesQuery(session: AiVaultSession, parsed: ParsedQuery): boolean {
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

  const repoLabel = folderLabel(session.cwd).toLowerCase()
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

function getFolderGroupKey(pathValue: string | null): string {
  return pathValue ? normalizeRuntimePathSeparators(pathValue).toLowerCase() : 'unknown'
}

function tokenizeQuery(query: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]+)"|'([^']+)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(query)) !== null) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token?.trim()) {
      tokens.push(token.trim())
    }
  }
  return tokens
}
