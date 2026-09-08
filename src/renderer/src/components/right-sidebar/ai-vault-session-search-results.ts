import { isWebClientLocation } from '@/lib/web-client-location'
import { useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type {
  AiVaultSearchArgs,
  AiVaultSearchCoverage,
  AiVaultSearchEvidence
} from '../../../../shared/ai-vault-search-types'
import { AI_VAULT_SEARCH_QUERY_MAX_LENGTH } from '../../../../shared/ai-vault-search-types'
import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import { isAiVaultSearchDisabled } from '../../../../shared/ai-vault-search-coverage'
import type { AiVaultSessionGroup } from './ai-vault-session-filters'
import { aiVaultSearchHitSessions } from './ai-vault-search-hit-sessions'

import { useAiVaultSearchCoveragePoll } from './ai-vault-search-coverage-poll'
import { useAiVaultSessionSearchRequest } from './ai-vault-session-search-request'

// Deep enough for the sidebar without asking the index for a page nobody scrolls to.
const AI_VAULT_SEARCH_PANEL_LIMIT = 50

export type AiVaultSessionSearchView = {
  /** True once the text half of the query is non-empty; the plain list is hidden. */
  active: boolean
  /** A host the index cannot reach is in scope, so those rows match on title only. */
  remoteHostsTitleOnly: boolean
  loading: boolean
  error: string | null
  coverage: AiVaultSearchCoverage | null
  /** Terms the index corrected before searching; empty when the query ran as typed. */
  repairedTerms: readonly string[]
  /** The host answered that the user has not turned transcript search on. */
  disabled: boolean
  /** Hits whose transcript file the host could not stat; they are shown but unverified. */
  sourceUnavailableFiles: number
  /** Runs the settled tier immediately; bound to Enter in the search box. */
  flush: () => void
  groups: readonly AiVaultSessionGroup[]
  /** What the list's loading/empty states should read while a search is active. */
  listCounts: { sessionsCount: number; filteredSessionsCount: number }
  newestFirst: boolean
  setNewestFirst: (newestFirst: boolean) => void
  evidenceFor: (session: AiVaultSession) => AiVaultSearchEvidence | null
}

export function useAiVaultSessionSearchResults(input: {
  /** False until the user consents; the panel then falls back to its metadata filter. */
  enabled: boolean
  query: string
  agents: readonly AiVaultAgent[]
  scopePaths: readonly string[]
  executionHostScope: ExecutionHostScope
  /** Whether any host other than this computer can be chosen in the panel's host menu. */
  remoteHostsAvailable: boolean
  sessions: readonly AiVaultSession[]
}): AiVaultSessionSearchView {
  const [newestFirst, setNewestFirst] = useState(false)
  const { agents, enabled, executionHostScope, query, scopePaths, sessions } = input

  // The desktop app searches its own index; a paired web client searches the runtime it addresses.
  const isDesktopApp = !isWebClientLocation()
  const supportedHost =
    !isDesktopApp ||
    executionHostScope === LOCAL_EXECUTION_HOST_ID ||
    executionHostScope === ALL_EXECUTION_HOSTS_SCOPE
  const remoteHostsTitleOnly =
    isDesktopApp &&
    (executionHostScope === ALL_EXECUTION_HOSTS_SCOPE
      ? input.remoteHostsAvailable
      : executionHostScope !== LOCAL_EXECUTION_HOST_ID)

  const args = useMemo((): AiVaultSearchArgs | null => {
    if (!enabled || !supportedHost || agents.length === 0 || !query.trim()) {
      return null
    }
    return {
      query: query.slice(0, AI_VAULT_SEARCH_QUERY_MAX_LENGTH),
      limit: AI_VAULT_SEARCH_PANEL_LIMIT,
      agents: [...agents],
      ...(scopePaths.length > 0 ? { scopePaths: [...scopePaths] } : {}),
      sort: newestFirst ? 'newest' : 'relevance'
    }
  }, [agents, enabled, newestFirst, query, scopePaths, supportedHost])

  const { current, error, flush, loading, result } = useAiVaultSessionSearchRequest(
    args,
    executionHostScope
  )
  // With an empty box no search runs, so the panel reads coverage directly to
  // report what is already searchable while the backfill is still going. Only a
  // current answer may publish its coverage: a retained older one carries a
  // reading from minutes ago that would rewind whatever the poll has since read.
  const polledCoverage = useAiVaultSearchCoveragePoll(
    enabled && supportedHost,
    current ? (result?.coverage ?? null) : null,
    isDesktopApp ? '' : executionHostScope
  )
  // Desktop search always reads this machine's index; a paired web client's
  // reads its runtime host, which is the scope it is pinned to.
  const executionHostId =
    isDesktopApp || executionHostScope === ALL_EXECUTION_HOSTS_SCOPE
      ? LOCAL_EXECUTION_HOST_ID
      : executionHostScope

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
          '{{count}} matches',
          { count: hitSessions.sessions.length }
        ),
        sessions: hitSessions.sessions
      }
    ]
  }, [hitSessions])

  return useMemo(
    () => ({
      active: args !== null,
      remoteHostsTitleOnly,
      loading,
      error,
      coverage: polledCoverage,
      repairedTerms: result?.repairedTerms ?? [],
      disabled: isAiVaultSearchDisabled(result?.coverage),
      sourceUnavailableFiles: result?.sourceUnavailableFiles ?? 0,
      flush,
      groups,
      listCounts: searchListCounts(sessions.length, hitSessions.sessions.length, loading),
      newestFirst,
      setNewestFirst,
      evidenceFor: (session: AiVaultSession) =>
        hitSessions.evidenceBySessionId.get(session.id) ?? null
    }),
    [
      args,
      error,
      flush,
      groups,
      hitSessions,
      loading,
      newestFirst,
      polledCoverage,
      remoteHostsTitleOnly,
      result,
      sessions.length
    ]
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
