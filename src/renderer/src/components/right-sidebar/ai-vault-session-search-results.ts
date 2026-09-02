import { useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type {
  AiVaultSearchArgs,
  AiVaultSearchCoverage,
  AiVaultSearchEvidence
} from '../../../../shared/ai-vault-search-types'
import { AI_VAULT_SEARCH_QUERY_MAX_LENGTH } from '../../../../shared/ai-vault-search-types'
import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import type { AiVaultSessionGroup } from './ai-vault-session-filters'
import { aiVaultSearchHitSessions } from './ai-vault-search-hit-sessions'
import {
  resolveAiVaultSearchScopePaths,
  splitAiVaultSearchQuery
} from './ai-vault-session-search-query-split'
import { useAiVaultSessionSearchRequest } from './ai-vault-session-search-request'

// Deep enough for the sidebar without asking the index for a page nobody scrolls to.
const AI_VAULT_SEARCH_PANEL_LIMIT = 50

export type AiVaultSessionSearchView = {
  /** True once the text half of the query is non-empty; the plain list is hidden. */
  active: boolean
  loading: boolean
  error: string | null
  coverage: AiVaultSearchCoverage | null
  groups: readonly AiVaultSessionGroup[]
  /** What the list's loading/empty states should read while a search is active. */
  listCounts: { sessionsCount: number; filteredSessionsCount: number }
  newestFirst: boolean
  setNewestFirst: (newestFirst: boolean) => void
  evidenceFor: (session: AiVaultSession) => AiVaultSearchEvidence | null
}

export function useAiVaultSessionSearchResults(input: {
  query: string
  agents: readonly AiVaultAgent[]
  scopePaths: readonly string[]
  executionHostScope: ExecutionHostScope
  sessions: readonly AiVaultSession[]
  worktrees: readonly Pick<Worktree, 'path' | 'repoId'>[]
  repos: readonly Pick<Repo, 'id' | 'displayName' | 'path'>[]
}): AiVaultSessionSearchView {
  const [newestFirst, setNewestFirst] = useState(false)
  const { agents, executionHostScope, query, repos, scopePaths, sessions, worktrees } = input

  const args = useMemo((): AiVaultSearchArgs | null => {
    const split = splitAiVaultSearchQuery(query)
    if (!split.text) {
      return null
    }
    const operatorPaths = resolveAiVaultSearchScopePaths(split, { worktrees, repos })
    const searchPaths = operatorPaths.length > 0 ? operatorPaths : scopePaths
    return {
      query: split.text.slice(0, AI_VAULT_SEARCH_QUERY_MAX_LENGTH),
      limit: AI_VAULT_SEARCH_PANEL_LIMIT,
      agents: [...agents],
      ...(searchPaths.length > 0 ? { scopePaths: [...searchPaths] } : {}),
      sort: newestFirst ? 'newest' : 'relevance'
    }
  }, [agents, newestFirst, query, repos, scopePaths, worktrees])

  const { error, loading, result } = useAiVaultSessionSearchRequest(args)
  // Desktop search always reads this machine's index; a paired web client's
  // reads its runtime host, which is the scope it is pinned to.
  const executionHostId =
    executionHostScope === ALL_EXECUTION_HOSTS_SCOPE ? LOCAL_EXECUTION_HOST_ID : executionHostScope

  const hitSessions = useMemo(
    () => aiVaultSearchHitSessions(result?.hits ?? [], sessions, executionHostId),
    [executionHostId, result, sessions]
  )

  const groups = useMemo((): AiVaultSessionGroup[] => {
    if (hitSessions.sessions.length === 0) {
      return []
    }
    return [
      {
        key: 'ai-vault-search-results',
        label: translate(
          'auto.components.right.sidebar.AiVaultPanel.searchMatches',
          '{{value0}} matches',
          { value0: hitSessions.sessions.length }
        ),
        sessions: hitSessions.sessions
      }
    ]
  }, [hitSessions])

  return useMemo(
    () => ({
      active: args !== null,
      loading,
      error,
      coverage: result?.coverage ?? null,
      groups,
      listCounts: searchListCounts(sessions.length, hitSessions.sessions.length, loading),
      newestFirst,
      setNewestFirst,
      evidenceFor: (session: AiVaultSession) =>
        hitSessions.evidenceBySessionId.get(session.id) ?? null
    }),
    [args, error, groups, hitSessions, loading, newestFirst, result, sessions.length]
  )
}

/**
 * Zero counts while the first answer is outstanding, so the list shows its
 * spinner instead of flashing "no sessions match" between keystrokes.
 */
function searchListCounts(
  listedCount: number,
  hitCount: number,
  loading: boolean
): { sessionsCount: number; filteredSessionsCount: number } {
  if (loading && hitCount === 0) {
    return { sessionsCount: 0, filteredSessionsCount: 0 }
  }
  return { sessionsCount: listedCount + hitCount, filteredSessionsCount: hitCount }
}
