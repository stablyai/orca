import { useCallback, useEffect, useMemo, useState } from 'react'
import { isWorktreePaletteQueryTooLarge } from '@/lib/worktree-palette-query-bounds'
import { PALETTE_SECTION_RENDER_CAP } from './cmd-j/palette-section-render-cap'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { SESSION_SEARCH_LIMIT_MAX } from '../../../shared/ai-vault-search-limit'
import { resolveAiVaultSearchSettings } from '../../../shared/ai-vault-search-settings'
import {
  aiVaultSearchNeedsLocalConsent,
  useAiVaultSearchPages
} from './right-sidebar/use-ai-vault-search'
import {
  fitPaletteTranscriptMatches,
  resolvePaletteTranscriptEligibleTabs,
  resolvePaletteTranscriptMatches
} from './worktree-jump-palette-transcript-matches'
import type { PaletteTranscriptSnippet } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { AiVaultSearchHit } from '../../../shared/ai-vault-search-types'
import { buildPaletteTranscriptIndex } from './cmd-j/palette-transcript-structured-tabs'
import { paletteTranscriptWorkspaceHost } from './cmd-j/palette-transcript-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import {
  paletteTranscriptEligibility,
  paletteTranscriptPaneState
} from './cmd-j/palette-transcript-eligibility'
import { eligibleSessionsKey } from '../../../shared/ai-vault-search-eligible-sessions'
import {
  classifyPaletteTranscriptProof,
  preparePaletteTranscriptProofQuery
} from './cmd-j/palette-transcript-proof'

const TRANSCRIPT_MATCH_DEBOUNCE_MS = 120
const NO_HITS: readonly AiVaultSearchHit[] = []
const NO_FITS: ReadonlyMap<number, PaletteTranscriptSnippet> = new Map()

type TranscriptMatchesInput = Pick<
  WorktreeJumpPaletteStoreState,
  | 'settings'
  | 'visible'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'workspaces'
  | 'unifiedTabsByWorktree'
> &
  Pick<WorktreeJumpPaletteLocalState, 'deferredQuery' | 'query' | 'filter'> &
  Partial<Pick<WorktreeJumpPaletteLocalState, 'expandedSectionCaps'>> &
  Pick<WorktreeJumpPaletteFilter, 'filterModel' | 'filterPredicate'>

/** Host-owned evidence, invalidated on raw input before deferred work commits. */
export function useWorktreeJumpPaletteTranscriptMatches({
  settings,
  visible,
  agentStatusByPaneKey,
  retainedAgentsByPaneKey,
  sleepingAgentSessionsByPaneKey,
  tabsByWorktree,
  terminalLayoutsByTabId,
  workspaces,
  unifiedTabsByWorktree,
  filterModel,
  filterPredicate,
  deferredQuery,
  expandedSectionCaps,
  query,
  filter
}: TranscriptMatchesInput) {
  const policy = useMemo(() => resolveAiVaultSearchSettings(settings), [settings])
  const transcriptGenerationKey = JSON.stringify([query, filter, policy, visible])
  const transcriptSearchEnabled =
    visible && query.trim().length > 0 && !isWorktreePaletteQueryTooLarge(query)
  const hostStates = useMemo(() => {
    const workspacesByHost = new Map<ExecutionHostId, Worktree[]>([[LOCAL_EXECUTION_HOST_ID, []]])
    for (const workspace of workspaces) {
      if (filterPredicate && !filterPredicate.matchesWorktree(workspace)) {
        continue
      }
      const host = paletteTranscriptWorkspaceHost(workspace, filterModel)
      if (host) {
        const owned = workspacesByHost.get(host) ?? []
        owned.push(workspace)
        workspacesByHost.set(host, owned)
      }
    }
    return [...workspacesByHost]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([executionHostId, owned]) => {
        const paneState = paletteTranscriptPaneState(
          {
            agentStatusByPaneKey,
            retainedAgentsByPaneKey,
            sleepingAgentSessionsByPaneKey,
            tabsByWorktree,
            terminalLayoutsByTabId
          },
          owned,
          unifiedTabsByWorktree,
          executionHostId
        )
        const index = buildPaletteTranscriptIndex(paneState, executionHostId)
        const eligibleSessions =
          transcriptSearchEnabled &&
          !aiVaultSearchNeedsLocalConsent(executionHostId, policy.enabled)
            ? paletteTranscriptEligibility(paneState, index)
            : null
        return { executionHostId, paneState, index, eligibleSessions }
      })
  }, [
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    sleepingAgentSessionsByPaneKey,
    tabsByWorktree,
    terminalLayoutsByTabId,
    workspaces,
    unifiedTabsByWorktree,
    filterModel,
    filterPredicate,
    transcriptSearchEnabled,
    policy.enabled
  ])
  const eligibilityKey = JSON.stringify(
    hostStates.map(({ executionHostId, eligibleSessions }) => [
      executionHostId,
      eligibleSessions === null ? 'invalid' : eligibleSessionsKey(eligibleSessions)
    ])
  )
  const requests = useMemo(
    () =>
      hostStates.map(({ executionHostId, eligibleSessions }) => ({
        scope: executionHostId,
        request:
          transcriptSearchEnabled &&
          deferredQuery === query &&
          eligibleSessions &&
          (eligibleSessions.providers.length > 0 || eligibleSessions.prompts.length > 0)
            ? {
                query: query.trim(),
                limit: SESSION_SEARCH_LIMIT_MAX,
                eligibleSessions,
                preserveForks: true,
                includeOriginalExcerpt: true
              }
            : null
      })),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- status timestamps do not change search eligibility.
    [transcriptSearchEnabled, deferredQuery, query, eligibilityKey]
  )
  const { pages } = useAiVaultSearchPages(
    requests,
    transcriptGenerationKey,
    TRANSCRIPT_MATCH_DEBOUNCE_MS
  )
  const [settled, setSettled] = useState<{
    key: string
    hitsByHost: ReadonlyMap<ExecutionHostId, readonly AiVaultSearchHit[]>
  }>({ key: transcriptGenerationKey, hitsByHost: new Map() })
  const stableHitsByHost = new Map<ExecutionHostId, readonly AiVaultSearchHit[]>()
  for (const page of pages) {
    const host = hostStates.find((entry) => entry.executionHostId === page.scope)
    if (!host) {
      continue
    }
    // Older hosts can silently drop optional fields; their title results remain usable.
    const acknowledgedHits =
      page.request &&
      page.response?.kind === 'results' &&
      page.response.eligibleSessionsApplied &&
      page.response.forksPreserved &&
      page.hits.length
        ? page.hits
        : NO_HITS
    stableHitsByHost.set(
      host.executionHostId,
      page.request && page.loading && settled.key === transcriptGenerationKey
        ? (settled.hitsByHost.get(host.executionHostId) ?? NO_HITS)
        : acknowledgedHits
    )
  }
  if (
    settled.key !== transcriptGenerationKey ||
    settled.hitsByHost.size !== stableHitsByHost.size ||
    [...stableHitsByHost].some(([host, hits]) => settled.hitsByHost.get(host) !== hits)
  ) {
    setSettled({ key: transcriptGenerationKey, hitsByHost: stableHitsByHost })
  }
  const stableHits = useMemo(() => [...settled.hitsByHost.values()].flat(), [settled])
  const proofWindows = useMemo(() => {
    if (!stableHits.length || !transcriptSearchEnabled) {
      return new Map()
    }
    const requirements = preparePaletteTranscriptProofQuery(query)
    return new Map(
      stableHits.map((hit) => [
        hit,
        classifyPaletteTranscriptProof(
          hit.evidence?.originalExcerpt?.text ?? '',
          requirements,
          hit.evidence?.originalExcerpt
        )
      ])
    )
  }, [stableHits, query, transcriptSearchEnabled])
  const candidates = useMemo(() => {
    let offset = 0
    return hostStates.flatMap(({ executionHostId, paneState, index }) => {
      const hits = settled.hitsByHost.get(executionHostId) ?? NO_HITS
      const matches = resolvePaletteTranscriptMatches(
        hits,
        paneState,
        query,
        proofWindows,
        index
      ).map((match) => ({ ...match, ordinal: match.ordinal + offset }))
      offset += hits.length
      return matches
    })
  }, [hostStates, settled, query, proofWindows])
  const destinationDemand =
    PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps?.['open-tabs'] ?? 0) + 1
  const transcriptEligibleTabs = useMemo(
    () =>
      new Set(
        hostStates.flatMap(({ paneState, index, eligibleSessions }) =>
          eligibleSessions ? [...resolvePaletteTranscriptEligibleTabs(paneState, index)] : []
        )
      ),
    [hostStates]
  )
  const [measured, setMeasured] = useState<{
    proofWindows: typeof proofWindows
    fits: ReadonlyMap<number, PaletteTranscriptSnippet>
    displayKey: string
    settled: boolean
    destinationDemand: number
  } | null>(null)
  const onFits = useCallback(
    (fits: ReadonlyMap<number, PaletteTranscriptSnippet>, displayKey: string, settled = true) => {
      setMeasured({ proofWindows, fits, displayKey, settled, destinationDemand })
    },
    [proofWindows, destinationDemand]
  )
  const transcriptMatches = useMemo(
    () =>
      measured?.proofWindows === proofWindows
        ? fitPaletteTranscriptMatches(candidates, measured.fits)
        : fitPaletteTranscriptMatches(candidates, NO_FITS),
    [candidates, measured, proofWindows]
  )
  useEffect(() => {
    if (
      measured?.proofWindows !== proofWindows ||
      !measured.settled ||
      measured.destinationDemand !== destinationDemand ||
      transcriptMatches.filter((match) => match.complete).length >= destinationDemand
    ) {
      return
    }
    for (const page of pages) {
      if (
        page.request &&
        !page.loading &&
        page.response?.kind === 'results' &&
        page.response.eligibleSessionsApplied &&
        page.response.forksPreserved &&
        page.response.page.hasMore
      ) {
        page.loadMore()
      }
    }
  }, [destinationDemand, measured, pages, proofWindows, transcriptMatches])
  return {
    transcriptMatches,
    transcriptEligibleTabs,
    transcriptGenerationKey,
    transcriptDisplayKey: measured?.displayKey ?? '',
    transcriptSearchEnabled,
    transcriptSearchIncomplete: pages.some(
      ({ request, response }) =>
        request &&
        response?.kind === 'results' &&
        response.eligibleSessionsApplied &&
        response.forksPreserved &&
        response.truncated.candidates &&
        !response.page.hasMore
    ),
    transcriptMeasurement: {
      generationKey: transcriptGenerationKey,
      candidates,
      destinationDemand,
      onFits
    }
  }
}

export type WorktreeJumpPaletteTranscriptMatches = ReturnType<
  typeof useWorktreeJumpPaletteTranscriptMatches
>
