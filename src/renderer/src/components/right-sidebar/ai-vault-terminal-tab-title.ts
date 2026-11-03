import type { AiVaultSearchSort, AiVaultSession } from '../../../../shared/ai-vault-types'
import { parseVaultQuery } from '../../../../shared/ai-vault-session-filters'
import {
  findOriginalAiVaultSessionPane,
  resolveOriginalPaneTarget,
  type OriginalPaneState
} from './ai-vault-original-pane'

/** The custom title of the open terminal tab running this session, if the user renamed it. */
export function terminalTabTitleForSession(
  state: OriginalPaneState,
  session: AiVaultSession
): string | null {
  const target = findOriginalAiVaultSessionPane(state, session)
  const tab = target
    ? state.tabsByWorktree[target.worktreeId]?.find((candidate) => candidate.id === target.tabId)
    : undefined
  return tab?.customTitle?.trim() || null
}

export type OpenRenamedTabSessionRef = { agent: string; sessionId: string; worktreeId: string }

function queryTerms(query: string): string[] {
  return parseVaultQuery(query).terms
}

/** Provider sessions running in open tabs whose rename matches every term, whether or not history loaded them. */
export function openRenamedTabSessionRefs(
  state: OriginalPaneState,
  query: string
): OpenRenamedTabSessionRef[] {
  const terms = queryTerms(query)
  if (terms.length === 0) {
    return []
  }
  const refs = new Map<string, OpenRenamedTabSessionRef>()
  const consider = (
    agent: string | undefined,
    sessionId: string | undefined,
    paneKey: string,
    worktreeIdHint: string | undefined,
    tabIdHint: string | undefined
  ): void => {
    if (!agent || !sessionId) {
      return
    }
    const target = resolveOriginalPaneTarget({ state, paneKey, worktreeIdHint, tabIdHint })
    const tab = target
      ? state.tabsByWorktree[target.worktreeId]?.find((candidate) => candidate.id === target.tabId)
      : undefined
    const title = tab?.customTitle?.trim().toLowerCase()
    if (target && title && terms.every((term) => title.includes(term))) {
      refs.set(`${agent}\u0000${sessionId}`, { agent, sessionId, worktreeId: target.worktreeId })
    }
  }
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    consider(
      entry.agentType,
      entry.providerSession?.id,
      entry.paneKey,
      entry.worktreeId,
      entry.tabId
    )
  }
  for (const retained of Object.values(state.retainedAgentsByPaneKey)) {
    consider(
      retained.agentType,
      retained.entry.providerSession?.id,
      retained.entry.paneKey,
      retained.worktreeId,
      retained.entry.tabId ?? retained.tab.id
    )
  }
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    consider(
      record.agent,
      record.providerSession.id,
      record.paneKey,
      record.worktreeId,
      record.tabId
    )
  }
  return [...refs.values()]
}

/** Host search indexes transcripts, not tab renames, so add history rows whose renamed tab matches every term. */
export function withTerminalTabTitleMatches(
  hitSessions: AiVaultSession[],
  history: readonly AiVaultSession[],
  query: string,
  sort: AiVaultSearchSort,
  state: OriginalPaneState
): AiVaultSession[] {
  const terms = queryTerms(query)
  if (terms.length === 0) {
    return hitSessions
  }
  const seen = new Set(hitSessions.map((session) => session.id))
  // Path-redacted hits have a different id from their history row; join on identity only when unambiguous.
  const identityCounts = new Map<string, number>()
  for (const session of history) {
    const key = sessionIdentity(session)
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1)
  }
  const hitIdentities = new Set(hitSessions.map(sessionIdentity))
  const extra = history.filter((session) => {
    const identity = sessionIdentity(session)
    if (
      seen.has(session.id) ||
      (identityCounts.get(identity) === 1 && hitIdentities.has(identity)) ||
      session.structuredSession
    ) {
      return false
    }
    const title = terminalTabTitleForSession(state, session)?.toLowerCase()
    return title !== undefined && terms.every((term) => title.includes(term))
  })
  if (extra.length === 0) {
    return hitSessions
  }
  const merged = [...hitSessions, ...extra]
  return sort === 'newest' ? merged.sort((a, b) => sessionTime(b) - sessionTime(a)) : merged
}

function sessionIdentity(
  session: Pick<AiVaultSession, 'executionHostId' | 'agent' | 'sessionId'>
): string {
  return JSON.stringify([session.executionHostId, session.agent, session.sessionId])
}

function sessionTime(session: AiVaultSession): number {
  const time = Date.parse(session.updatedAt ?? session.modifiedAt)
  return Number.isNaN(time) ? 0 : time
}
