import { useMemo } from 'react'
import type { AiVaultGroup, AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  filterAiVaultSessions,
  groupAiVaultSessions,
  type AiVaultSessionFilterState
} from '../../../../shared/ai-vault-session-filters'
// Keep renderer imports stable while mobile reuses the shared core; Metro cannot import renderer code.
export type {
  AiVaultSessionProject,
  AiVaultSessionFilterState,
  AiVaultSessionGroup
} from '../../../../shared/ai-vault-session-filters'
export {
  AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES,
  agentLabel,
  filterAiVaultSessions,
  folderLabel,
  groupAiVaultSessions,
  isAiVaultSessionFilterQueryTooLarge,
  parseVaultQuery
} from '../../../../shared/ai-vault-session-filters'

/** What the list renders: a null label is a group of rows with no header of its own. */
export type AiVaultSessionListGroup = {
  key: string
  label: string | null
  sessions: AiVaultSession[]
}

/** Host hits are already scoped by the host; rows added from open tab titles still need the panel's agent/scope filters. */
function withScopedTabTitleMatches(
  sessions: readonly AiVaultSession[],
  searchHits: readonly AiVaultSession[],
  filters: AiVaultSessionFilterState
): AiVaultSession[] {
  const searchHitIds = new Set(searchHits.map((session) => session.id))
  const additions = sessions.filter((session) => !searchHitIds.has(session.id))
  if (additions.length === 0) {
    return [...sessions]
  }
  const allowed = new Set(filterAiVaultSessions(additions, filters).map((session) => session.id))
  return sessions.filter((session) => searchHitIds.has(session.id) || allowed.has(session.id))
}

export function useAiVaultPanelSessions(
  sessions: readonly AiVaultSession[],
  searching: boolean,
  group: AiVaultGroup,
  {
    query,
    agents,
    scope,
    sort,
    activeWorktreePaths,
    activeProjectKey,
    sessionProjectById,
    projectLabelByKey,
    hideEmptySessions,
    terminalTabTitleFor,
    searchHits
  }: AiVaultSessionFilterState & { searchHits: readonly AiVaultSession[] }
) {
  const filters = useMemo<AiVaultSessionFilterState>(
    () => ({
      query,
      agents,
      scope,
      sort,
      activeWorktreePaths,
      activeProjectKey,
      sessionProjectById,
      projectLabelByKey,
      hideEmptySessions,
      terminalTabTitleFor
    }),
    [
      query,
      agents,
      scope,
      sort,
      activeWorktreePaths,
      activeProjectKey,
      sessionProjectById,
      projectLabelByKey,
      hideEmptySessions,
      terminalTabTitleFor
    ]
  )
  const filteredSessions = useMemo(
    () =>
      searching
        ? withScopedTabTitleMatches(sessions, searchHits, filters)
        : filterAiVaultSessions(sessions, filters),
    [searching, searchHits, sessions, filters]
  )
  const groups = useMemo<AiVaultSessionListGroup[]>(
    () =>
      searching
        ? filteredSessions.length === 0
          ? []
          : // The results bar above the list carries the count, so this group only holds rows.
            [{ key: 'search-results', label: null, sessions: [...filteredSessions] }]
        : groupAiVaultSessions(filteredSessions, group, { sessionProjectById, projectLabelByKey }),
    [searching, filteredSessions, group, projectLabelByKey, sessionProjectById]
  )
  return { filteredSessions, groups }
}
