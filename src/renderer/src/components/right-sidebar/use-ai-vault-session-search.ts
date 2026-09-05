import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  searchAiVaultSessionsWithAi,
  type AiVaultAiSearchResult
} from '../../../../shared/ai-vault-session-ai-query'
import {
  filterAiVaultSessions,
  type AiVaultSessionFilterState
} from '../../../../shared/ai-vault-session-filters'
import { AiVaultSessionSearchIndex } from '../../../../shared/ai-vault-session-index'
import { parseVaultQuery } from '../../../../shared/ai-vault-session-query'
import { isAiVaultRgSearchScope } from '../../../../shared/ai-vault-session-search-scope'
import type { AiVaultSessionMessageHit } from '../../../../shared/ai-vault-session-message-hit'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

const RG_SEARCH_DEBOUNCE_MS = 280

type AiVaultSearchReset = {
  activeProjectKey: AiVaultSessionFilterState['activeProjectKey']
  activeWorktreePaths: AiVaultSessionFilterState['activeWorktreePaths']
  agents: AiVaultSessionFilterState['agents']
  hideEmptySessions: boolean
  hosts: AiVaultSessionFilterState['hosts']
  projectLabelByKey: AiVaultSessionFilterState['projectLabelByKey']
  query: string
  scope: AiVaultSessionFilterState['scope']
  searchScope: AiVaultSessionFilterState['searchScope']
  sessionProjectById: AiVaultSessionFilterState['sessionProjectById']
  sort: AiVaultSessionFilterState['sort']
  timeRange: AiVaultSessionFilterState['timeRange']
  sessions: readonly AiVaultSession[]
}

type AiSearchSnapshot = {
  reset: AiVaultSearchReset
  result: AiVaultAiSearchResult | null
  error: string | null
  loading: boolean
}

type RgSearchHits = {
  key: string
  matchedIds: string[] | null
  usedRg: boolean
  usedFts: boolean
  messageHits: AiVaultSessionMessageHit[]
  unavailable: boolean
}

function takeAiVaultSearchReset(
  filters: AiVaultSessionFilterState,
  sessions: readonly AiVaultSession[]
): AiVaultSearchReset {
  return {
    activeProjectKey: filters.activeProjectKey,
    activeWorktreePaths: filters.activeWorktreePaths,
    agents: filters.agents,
    hideEmptySessions: filters.hideEmptySessions,
    hosts: filters.hosts,
    projectLabelByKey: filters.projectLabelByKey,
    query: filters.query,
    scope: filters.scope,
    searchScope: filters.searchScope,
    sessionProjectById: filters.sessionProjectById,
    sort: filters.sort,
    timeRange: filters.timeRange,
    sessions
  }
}

function aiVaultSearchResetChanged(left: AiVaultSearchReset, right: AiVaultSearchReset): boolean {
  return (
    left.sessions !== right.sessions ||
    left.query !== right.query ||
    left.searchScope !== right.searchScope ||
    left.scope !== right.scope ||
    left.sort !== right.sort ||
    left.timeRange !== right.timeRange ||
    left.hideEmptySessions !== right.hideEmptySessions ||
    left.activeProjectKey !== right.activeProjectKey ||
    left.activeWorktreePaths !== right.activeWorktreePaths ||
    left.agents !== right.agents ||
    left.hosts !== right.hosts ||
    left.projectLabelByKey !== right.projectLabelByKey ||
    left.sessionProjectById !== right.sessionProjectById
  )
}

export function useAiVaultSessionSearch(args: {
  sessions: readonly AiVaultSession[]
  filters: AiVaultSessionFilterState
  repoId?: string | null
}): {
  filteredSessions: AiVaultSession[]
  aiLoading: boolean
  aiError: string | null
  usedModel: boolean
  rgLoading: boolean
  rgHitCount: number | null
  usedRg: boolean
  usedFts: boolean
  messageHitsBySessionId: ReadonlyMap<string, AiVaultSessionMessageHit>
  runAiSearch: () => Promise<void>
} {
  const { sessions, filters, repoId } = args
  const indexRef = useRef(new AiVaultSessionSearchIndex())
  const requestIdRef = useRef(0)
  const rgRequestIdRef = useRef(0)
  const searchReset = takeAiVaultSearchReset(filters, sessions)
  const [aiSnapshot, setAiSnapshot] = useState<AiSearchSnapshot | null>(null)
  const [rgHits, setRgHits] = useState<RgSearchHits | null>(null)
  const [rgLoading, setRgLoading] = useState(false)
  // Why: key AI hits to the current filters so a query/scope change drops stale
  // ranking without setState or ref writes during render.
  const ai =
    aiSnapshot != null && !aiVaultSearchResetChanged(aiSnapshot.reset, searchReset)
      ? aiSnapshot
      : null

  const lexicalSessions = useMemo(() => {
    indexRef.current.sync(sessions, {
      sessionProjectById: filters.sessionProjectById,
      projectLabelByKey: filters.projectLabelByKey
    })
    return filterAiVaultSessions(sessions, filters, {
      index: indexRef.current
    })
  }, [filters, sessions])

  const searchTerms = useMemo(() => parseVaultQuery(filters.query).terms, [filters.query])
  const usesRgScope = isAiVaultRgSearchScope(filters.searchScope ?? 'full')
  const rgQueryActive = usesRgScope && searchTerms.length > 0
  const candidateIdKey = lexicalSessions.map((session) => session.id).join('\n')
  const rgKey = `${searchTerms.join('\0')}\0${filters.searchScope ?? ''}\0${candidateIdKey}`
  const rg = rgHits != null && rgHits.key === rgKey ? rgHits : null

  useEffect(() => {
    if (!rgQueryActive) {
      rgRequestIdRef.current += 1
      return
    }

    const requestId = rgRequestIdRef.current + 1
    rgRequestIdRef.current = requestId
    setRgLoading(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await window.api.aiVault.searchSessions({
            query: searchTerms.join(' '),
            searchScope:
              filters.searchScope === 'title' || filters.searchScope === 'summary'
                ? 'full'
                : (filters.searchScope ?? 'full'),
            sessionIds: candidateIdKey.split('\n').filter(Boolean)
          })
          if (rgRequestIdRef.current !== requestId) {
            return
          }
          if (!result.usedRg && !result.usedFts) {
            setRgHits({
              key: rgKey,
              matchedIds: null,
              usedRg: false,
              usedFts: false,
              messageHits: [],
              unavailable: true
            })
            return
          }
          setRgHits({
            key: rgKey,
            matchedIds: result.matchedIds,
            usedRg: result.usedRg,
            usedFts: result.usedFts,
            messageHits: result.hits,
            unavailable: false
          })
        } catch {
          if (rgRequestIdRef.current === requestId) {
            setRgHits({
              key: rgKey,
              matchedIds: null,
              usedRg: false,
              usedFts: false,
              messageHits: [],
              unavailable: true
            })
          }
        } finally {
          if (rgRequestIdRef.current === requestId) {
            setRgLoading(false)
          }
        }
      })()
    }, RG_SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [candidateIdKey, filters.searchScope, rgKey, rgQueryActive, searchTerms])

  const cardFallbackSessions = useMemo(() => {
    if (!rgQueryActive || !rg?.unavailable) {
      return null
    }
    return filterAiVaultSessions(sessions, filters, {
      index: indexRef.current,
      forceCardTerms: true
    })
  }, [filters, rg, rgQueryActive, sessions])

  const retrievalSessions = useMemo(() => {
    if (!rgQueryActive) {
      return lexicalSessions
    }
    if (cardFallbackSessions) {
      return cardFallbackSessions
    }
    if ((!rg?.usedRg && !rg?.usedFts) || rg.matchedIds === null) {
      // Why: keep the panel usable while rg is in flight; do not block typing.
      return lexicalSessions
    }
    const allowed = new Set(rg.matchedIds)
    return lexicalSessions.filter((session) => allowed.has(session.id))
  }, [cardFallbackSessions, lexicalSessions, rg, rgQueryActive])

  const runAiSearch = useCallback(async () => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const reset = takeAiVaultSearchReset(filters, sessions)
    setAiSnapshot({ reset, result: null, error: null, loading: true })
    try {
      const result = await searchAiVaultSessionsWithAi({
        sessions: retrievalSessions,
        filters,
        candidates: retrievalSessions,
        options: { index: indexRef.current },
        rerank: async (query, cards) => {
          const ranked = await window.api.aiVault.rankSessions({ query, cards, repoId })
          if (!ranked.ok && ranked.error) {
            throw new Error(ranked.error)
          }
          return { rankedIds: ranked.rankedIds, usedModel: ranked.usedModel }
        }
      })
      if (requestIdRef.current === requestId) {
        setAiSnapshot({ reset, result, error: null, loading: false })
      }
    } catch (error) {
      if (requestIdRef.current === requestId) {
        setAiSnapshot({
          reset,
          result: null,
          error: error instanceof Error ? error.message : String(error),
          loading: false
        })
      }
    }
  }, [filters, repoId, retrievalSessions, sessions])

  return {
    filteredSessions: ai?.result?.sessions ?? retrievalSessions,
    aiLoading: ai?.loading ?? false,
    aiError: ai?.error ?? null,
    usedModel: ai?.result?.usedModel ?? false,
    rgLoading: rgQueryActive && rgLoading,
    rgHitCount:
      rgQueryActive && (rg?.usedRg || rg?.usedFts) && rg.matchedIds ? rg.matchedIds.length : null,
    usedRg: rg?.usedRg ?? false,
    usedFts: rg?.usedFts ?? false,
    messageHitsBySessionId: new Map((rg?.messageHits ?? []).map((hit) => [hit.sessionId, hit])),
    runAiSearch
  }
}
