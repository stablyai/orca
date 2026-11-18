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

/** Rows that list as one, as a group room's members: placed before filters run, folded after. */
export type AiVaultRoomRows = {
  place: (rows: readonly AiVaultSession[]) => readonly AiVaultSession[]
  fold: (rows: readonly AiVaultSession[]) => readonly AiVaultSession[]
}

const keepRows = (rows: readonly AiVaultSession[]): readonly AiVaultSession[] => rows
const KEEP_ROWS: AiVaultRoomRows = { place: keepRows, fold: keepRows }

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
    hideEmptySessions,
    preserveStructuredSessions,
    roomRows = KEEP_ROWS
  }: AiVaultSessionFilterState & { roomRows?: AiVaultRoomRows }
) {
  const filteredSessions = useMemo(() => {
    const placed = roomRows.place(sessions)
    return roomRows.fold(
      mode === 'search-hits'
        ? placed
        : filterAiVaultSessions(placed, {
            query,
            agents,
            scope,
            sort,
            activeWorktreePaths,
            activeProjectKey,
            sessionProjectById,
            projectLabelByKey,
            hideEmptySessions,
            preserveStructuredSessions
          })
    )
  }, [
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
    hideEmptySessions,
    preserveStructuredSessions,
    roomRows
  ])
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
