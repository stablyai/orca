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
import { useTranslate } from '@/i18n/use-translate'
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

const NO_PINNED_SESSIONS: readonly string[] = []

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
    roomRows = KEEP_ROWS,
    pinnedSessions = NO_PINNED_SESSIONS
  }: AiVaultSessionFilterState & {
    roomRows?: AiVaultRoomRows
    pinnedSessions?: readonly string[]
  }
) {
  const t = useTranslate()
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
            hideEmptySessions
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
    roomRows
  ])
  const groups = useMemo<AiVaultSessionListGroup[]>(() => {
    if (mode !== 'browse') {
      return filteredSessions.length === 0
        ? []
        : // The results bar above the list carries the count, so this group only holds rows.
          [{ key: 'search-results', label: null, sessions: [...filteredSessions] }]
    }
    const grouped = groupAiVaultSessions(filteredSessions, group, {
      sessionProjectById,
      projectLabelByKey
    })
    if (pinnedSessions.length === 0) {
      return grouped
    }
    const pinnedRank = new Map(pinnedSessions.map((id, index) => [id, index]))
    const pinned: AiVaultSession[] = []
    const unpinned = grouped
      .map((entry) => {
        const sessions = entry.sessions.filter((session) => {
          if (!pinnedRank.has(session.id)) {
            return true
          }
          pinned.push(session)
          return false
        })
        return sessions === entry.sessions ? entry : { ...entry, sessions }
      })
      .filter((entry) => entry.sessions.length > 0)
    if (pinned.length === 0) {
      return grouped
    }
    pinned.sort((left, right) => (pinnedRank.get(left.id) ?? 0) - (pinnedRank.get(right.id) ?? 0))
    return [
      {
        key: 'pinned',
        label: t('auto.components.right.sidebar.AiVaultSessionList.pinnedSessions', 'Pinned'),
        sessions: pinned
      },
      ...unpinned
    ]
  }, [mode, filteredSessions, group, projectLabelByKey, sessionProjectById, pinnedSessions, t])
  return { filteredSessions, groups }
}
