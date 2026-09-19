import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import type { AiVaultSession, AiVaultGroup } from '../../../../shared/ai-vault-types'
import {
  filterAiVaultSessions,
  groupAiVaultSessions,
  type AiVaultSessionFilterState
} from '../../../../shared/ai-vault-session-filters'
// Why: the pure filter/group/query core now lives in /shared so the mobile
// package can reuse it (Metro can't import renderer). Re-export for renderer
// import parity. Not a byte-for-byte move: tokenizeQuery gained quoted
// repo:/path: operator values (e.g. path:"/a/My Project"), which the old
// renderer tokenizer split on spaces.
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
  const groups = useMemo(
    () =>
      searching
        ? filteredSessions.length === 0
          ? []
          : [
              {
                key: 'search-results',
                label: translate('sessionSearch.panel.rankedResults', 'Best matches'),
                sessions: [...filteredSessions]
              }
            ]
        : groupAiVaultSessions(filteredSessions, group, { sessionProjectById, projectLabelByKey }),
    [searching, filteredSessions, group, projectLabelByKey, sessionProjectById]
  )
  return { filteredSessions, groups }
}
