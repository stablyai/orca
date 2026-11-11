import { useMemo } from 'react'
import type {
  AiVaultGroup,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  filterAiVaultSessions,
  groupAiVaultSessions,
  type AiVaultSessionFilterState
} from '../../../../../../shared/ai-vault/session-display/ai-vault-session-filters'
// Keep renderer imports stable while mobile reuses the shared core; Metro cannot import renderer code.

/** What the list renders: a null label is a group of rows with no header of its own. */
export type AiVaultSessionListGroup = {
  key: string
  label: string | null
  sessions: AiVaultSession[]
}

/** Browse groups title-filtered sessions; search lists hits as given, or title matches until hits arrive. */
export type AiVaultPanelListMode = 'browse' | 'search-hits' | 'search-titles'

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
  mode: AiVaultPanelListMode,
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
      mode === 'search-hits'
        ? withScopedTabTitleMatches(sessions, searchHits, filters)
        : filterAiVaultSessions(sessions, filters),
    [mode, searchHits, sessions, filters]
  )
  const groups = useMemo<AiVaultSessionListGroup[]>(
    () =>
      mode !== 'browse'
        ? filteredSessions.length === 0
          ? []
          : // The results bar above the list carries the count, so this group only holds rows.
            [{ key: 'search-results', label: null, sessions: [...filteredSessions] }]
        : groupAiVaultSessions(filteredSessions, group, { sessionProjectById, projectLabelByKey }),
    [mode, filteredSessions, group, projectLabelByKey, sessionProjectById]
  )
  return { filteredSessions, groups }
}
