import { useCallback, useMemo, useState } from 'react'
import type {
  AiVaultSearchSort,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { ExecutionHostScope } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { useAiVaultPanelSearchSessions } from '../search/ai-vault-search-session'
import {
  terminalTabTitleForSession,
  withTerminalTabTitleMatches
} from './ai-vault-terminal-tab-title'
import { useAiVaultOpenTabSessions } from './use-ai-vault-open-tab-sessions'

/** Rows to render: host hits (when searching) plus sessions whose open terminal tab was renamed to match the query. */
export function useAiVaultSearchSessions(
  search: Parameters<typeof useAiVaultPanelSearchSessions>[0] & {
    onDeleted: (session: AiVaultSession) => void
  },
  history: readonly AiVaultSession[],
  query: string,
  sort: AiVaultSearchSort,
  executionHostScope: ExecutionHostScope,
  worktrees: readonly { id: string; path: string }[]
) {
  const listing = useAiVaultPanelSearchSessions(search, history)
  const onHitDeleted = search.onDeleted

  const agentStatusByPaneKey = useAppStore((state) => state.agentStatusByPaneKey)
  const retainedAgentsByPaneKey = useAppStore((state) => state.retainedAgentsByPaneKey)
  const sleepingAgentSessionsByPaneKey = useAppStore(
    (state) => state.sleepingAgentSessionsByPaneKey
  )
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const terminalLayoutsByTabId = useAppStore((state) => state.terminalLayoutsByTabId)
  const paneState = useMemo(
    () => ({
      agentStatusByPaneKey,
      retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey,
      tabsByWorktree,
      terminalLayoutsByTabId
    }),
    [
      agentStatusByPaneKey,
      retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey,
      tabsByWorktree,
      terminalLayoutsByTabId
    ]
  )
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(new Set())
  const fetchedOpenTabSessions = useAiVaultOpenTabSessions(
    history,
    query,
    executionHostScope,
    worktrees,
    paneState
  )
  const terminalTabTitleFor = useCallback(
    (session: AiVaultSession) => terminalTabTitleForSession(paneState, session),
    [paneState]
  )
  // Deleted ids are filtered at render so a stale history row or in-flight fetch cannot bring one back.
  const candidates = useMemo(
    () => [...history, ...fetchedOpenTabSessions].filter((session) => !deletedIds.has(session.id)),
    [history, fetchedOpenTabSessions, deletedIds]
  )
  const showingHits = listing.listMode === 'search-hits'
  const sessions = useMemo(
    () =>
      showingHits
        ? withTerminalTabTitleMatches(listing.sessions, candidates, query, sort, paneState)
        : candidates,
    [showingHits, listing.sessions, candidates, query, sort, paneState]
  )
  const resolverSessions = showingHits && sessions.length > 0 ? sessions : history
  const onDeleted = useCallback(
    (session: AiVaultSession) => {
      onHitDeleted(session)
      setDeletedIds((current) => new Set(current).add(session.id))
    },
    [onHitDeleted]
  )
  return { ...listing, sessions, resolverSessions, terminalTabTitleFor, onDeleted }
}
