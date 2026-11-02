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
    hideEmptySessions
  }: AiVaultSessionFilterState
) {
  const filteredSessions = useMemo(
    () =>
      searching
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
      searching,
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
