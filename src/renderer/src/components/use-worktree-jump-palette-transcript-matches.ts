import { useMemo } from 'react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { SESSION_SEARCH_LIMIT_MAX } from '../../../shared/ai-vault-search-limit'
import { resolveAiVaultSearchSettings } from '../../../shared/ai-vault-search-settings'
import {
  aiVaultSearchNeedsLocalConsent,
  useAiVaultSearch
} from './right-sidebar/use-ai-vault-search'
import { resolvePaletteTranscriptMatches } from './worktree-jump-palette-transcript-matches'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'

// The index ranks every recorded session; only open ones survive, so take the largest page.
const TRANSCRIPT_MATCH_LIMIT = SESSION_SEARCH_LIMIT_MAX
// Shorter than the sidebar's: the palette already defers the query once.
const TRANSCRIPT_MATCH_DEBOUNCE_MS = 120

type WorktreeJumpPaletteTranscriptMatchesInput = Pick<
  WorktreeJumpPaletteStoreState,
  | 'settings'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
> &
  Pick<WorktreeJumpPaletteLocalState, 'deferredQuery'>

/** Open chats whose transcript matches the query, from this desktop's session index. */
export function useWorktreeJumpPaletteTranscriptMatches({
  settings,
  agentStatusByPaneKey,
  retainedAgentsByPaneKey,
  sleepingAgentSessionsByPaneKey,
  tabsByWorktree,
  terminalLayoutsByTabId,
  deferredQuery
}: WorktreeJumpPaletteTranscriptMatchesInput) {
  const policy = useMemo(() => resolveAiVaultSearchSettings(settings), [settings])
  const trimmed = deferredQuery.trim()
  const searchable =
    trimmed.length > 0 && !aiVaultSearchNeedsLocalConsent(LOCAL_EXECUTION_HOST_ID, policy.enabled)
  const request = useMemo(
    () => (searchable ? { query: trimmed, limit: TRANSCRIPT_MATCH_LIMIT } : null),
    [searchable, trimmed]
  )
  const { hits } = useAiVaultSearch(
    request,
    LOCAL_EXECUTION_HOST_ID,
    JSON.stringify(policy),
    TRANSCRIPT_MATCH_DEBOUNCE_MS
  )
  const transcriptMatches = useMemo(
    () =>
      resolvePaletteTranscriptMatches(hits, {
        agentStatusByPaneKey,
        retainedAgentsByPaneKey,
        sleepingAgentSessionsByPaneKey,
        tabsByWorktree,
        terminalLayoutsByTabId
      }),
    [
      hits,
      agentStatusByPaneKey,
      retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey,
      tabsByWorktree,
      terminalLayoutsByTabId
    ]
  )
  return { transcriptMatches }
}

export type WorktreeJumpPaletteTranscriptMatches = ReturnType<
  typeof useWorktreeJumpPaletteTranscriptMatches
>
