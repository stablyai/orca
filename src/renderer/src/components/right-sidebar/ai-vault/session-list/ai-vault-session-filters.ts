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
    hideEmptySessions
  }: AiVaultSessionFilterState
) {
  const filteredSessions = useMemo(
    () =>
      mode === 'search-hits'
        ? sessions
        : filterAiVaultSessions(sessions, {
            query,
            agents,
            scope,
            sort,
            activeWorktreePaths,
            activeProjectKey,
            sessionProjectById,
            projectLabelByKey,
            hideEmptySessions
          }),
    [
      mode,
      sessions,
      query,
      agents,
      scope,
      sort,
      activeWorktreePaths,
      activeProjectKey,
      sessionProjectById,
      projectLabelByKey,
      hideEmptySessions
    ]
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
