import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import type { AiVaultSession, AiVaultGroup } from '../../../../shared/ai-vault-types'
import {
  filterAiVaultSessions,
  groupAiVaultSessions,
  type AiVaultSessionFilterState
} from '../../../../shared/ai-vault-session-filters'
import { useAiVaultOriginalPaneActions } from './ai-vault-original-pane-actions'
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
    hideEmptySessions,
    /** Full history list used to find rename-only matches during desktop search. */
    historySessions
  }: AiVaultSessionFilterState & { historySessions?: readonly AiVaultSession[] }
) {
  const { getSessionDisplayTitle } = useAiVaultOriginalPaneActions()
  const titleSourceSessions = searching && historySessions ? historySessions : sessions
  const sessionDisplayTitleById = useMemo(() => {
    const titles = new Map<string, string>()
    for (const session of titleSourceSessions) {
      const title = getSessionDisplayTitle(session)
      if (title !== session.title) {
        titles.set(session.id, title)
      }
    }
    return titles
  }, [getSessionDisplayTitle, titleSourceSessions])

  const filteredSessions = useMemo(() => {
    const filterInput = {
      query,
      agents,
      scope,
      sort,
      activeWorktreePaths,
      activeProjectKey,
      sessionProjectById,
      projectLabelByKey,
      hideEmptySessions,
      sessionDisplayTitleById
    }
    if (!searching) {
      return filterAiVaultSessions(sessions, filterInput)
    }
    // Desktop search answers the query in the main process, which cannot see
    // renderer tab renames. Keep main-process hits, then union history rows
    // that match via the Orca overlay title (shared filter branch).
    const byId = new Map(sessions.map((session) => [session.id, session]))
    if (historySessions && historySessions.length > 0 && query.trim().length > 0) {
      for (const session of filterAiVaultSessions(historySessions, filterInput)) {
        if (!byId.has(session.id)) {
          byId.set(session.id, session)
        }
      }
    }
    return [...byId.values()]
  }, [
    searching,
    sessions,
    historySessions,
    query,
    agents,
    scope,
    sort,
    activeWorktreePaths,
    activeProjectKey,
    sessionProjectById,
    projectLabelByKey,
    hideEmptySessions,
    sessionDisplayTitleById
  ])
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
