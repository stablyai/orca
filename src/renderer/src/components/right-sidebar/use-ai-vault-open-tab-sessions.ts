import { useEffect, useMemo, useState } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { OriginalPaneState } from './ai-vault-original-pane'
import { openRenamedTabSessionRefs } from './ai-vault-terminal-tab-title'

type WorktreePath = { id: string; path: string }

/** Open renamed tabs can run sessions older than the history cap; load those through their worktree scope. */
export function useAiVaultOpenTabSessions(
  history: readonly AiVaultSession[],
  query: string,
  executionHostScope: ExecutionHostScope,
  worktrees: readonly WorktreePath[],
  paneState: OriginalPaneState
): AiVaultSession[] {
  const missing = useMemo(() => {
    const loaded = new Set(history.map((session) => `${session.agent}\u0000${session.sessionId}`))
    return openRenamedTabSessionRefs(paneState, query).filter(
      (ref) => !loaded.has(`${ref.agent}\u0000${ref.sessionId}`)
    )
  }, [history, paneState, query])
  const scopePaths = useMemo(() => {
    const pathById = new Map(worktrees.map((worktree) => [worktree.id, worktree.path]))
    const paths = new Set<string>()
    for (const ref of missing) {
      const path = pathById.get(ref.worktreeId)
      if (path) {
        paths.add(path)
      }
    }
    return [...paths].sort()
  }, [missing, worktrees])
  const scopeKey = JSON.stringify(scopePaths)
  const [fetched, setFetched] = useState<{
    executionHostScope: ExecutionHostScope
    scopeKey: string
    sessions: AiVaultSession[]
  } | null>(null)

  useEffect(() => {
    if (scopePaths.length === 0) {
      return
    }
    const requestToken = createBrowserUuid()
    let cancelled = false
    void window.api.aiVault
      .listSessions({ scopePaths, executionHostScope, requestToken })
      .then((result) => {
        if (!cancelled && !result.cancelled) {
          setFetched({ executionHostScope, scopeKey, sessions: result.sessions })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
      void window.api.aiVault.cancelListSessions({ requestToken }).catch(() => {})
    }
    // scopeKey stands in for scopePaths so typing within one match set does not refetch.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, executionHostScope])

  return useMemo(() => {
    // Rows from another host scope or worktree set must not outlive a failed or pending refetch.
    if (
      missing.length === 0 ||
      !fetched ||
      fetched.executionHostScope !== executionHostScope ||
      fetched.scopeKey !== scopeKey
    ) {
      return []
    }
    const wanted = new Set(missing.map((ref) => `${ref.agent}\u0000${ref.sessionId}`))
    return fetched.sessions.filter((session) =>
      wanted.has(`${session.agent}\u0000${session.sessionId}`)
    )
  }, [fetched, missing, executionHostScope, scopeKey])
}
