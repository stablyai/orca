import { useCallback, useMemo, useState } from 'react'
import type { AiVaultSearchSort, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { withAiVaultHistoryPreviews } from './ai-vault-search-session'
import {
  terminalTabTitleForSession,
  withTerminalTabTitleMatches
} from './ai-vault-terminal-tab-title'
import { useAiVaultOpenTabSessions } from './use-ai-vault-open-tab-sessions'

/** Rows to render: host hits (when searching) plus sessions whose open terminal tab was renamed to match the query. */
export function useAiVaultSearchSessions(
  searching: boolean,
  hitSessions: AiVaultSession[],
  history: readonly AiVaultSession[],
  query: string,
  sort: AiVaultSearchSort,
  executionHostScope: ExecutionHostScope,
  worktrees: readonly { id: string; path: string }[],
  onHitDeleted: (session: AiVaultSession) => void
): {
  sessions: readonly AiVaultSession[]
  terminalTabTitleFor: (session: AiVaultSession) => string | null
  onDeleted: (session: AiVaultSession) => void
} {
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
  const sessions = useMemo(
    () =>
      searching
        ? withTerminalTabTitleMatches(
            withAiVaultHistoryPreviews(hitSessions, history),
            candidates,
            query,
            sort,
            paneState
          )
        : fetchedOpenTabSessions.length > 0
          ? candidates
          : history,
    [searching, hitSessions, history, candidates, fetchedOpenTabSessions, query, sort, paneState]
  )
  const onDeleted = useCallback(
    (session: AiVaultSession) => {
      onHitDeleted(session)
      setDeletedIds((current) => new Set(current).add(session.id))
    },
    [onHitDeleted]
  )
  return { sessions, terminalTabTitleFor, onDeleted }
}
