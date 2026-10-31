import { useMemo } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  filterAiVaultSessions,
  type AiVaultSessionFilterState
} from '../../../../shared/ai-vault-session-filters'
import { conversationPreferenceKey } from '../../../../shared/conversation-navigation-preferences'

/** Keep indexed content matches and add bounded, host-owned conversation metadata matches. */
export function mergeAiVaultConversationSearch(
  indexed: readonly AiVaultSession[],
  history: readonly AiVaultSession[],
  filters: AiVaultSessionFilterState
): { sessions: AiVaultSession[]; hasMetadataMatches: boolean } {
  const metadata = filterAiVaultSessions(history, filters)
  const known = new Map(history.map((session) => [conversationPreferenceKey(session), session]))
  const matched = new Map<string, AiVaultSession>()
  for (const session of indexed) {
    const key = conversationPreferenceKey(session)
    matched.set(key, known.get(key) ?? session)
  }
  for (const session of metadata) {
    const key = conversationPreferenceKey(session)
    if (!matched.has(key)) {
      matched.set(key, session)
    }
  }
  return { sessions: [...matched.values()], hasMetadataMatches: metadata.length > 0 }
}

export function useAiVaultConversationSearch(
  enabled: boolean,
  indexed: readonly AiVaultSession[],
  history: readonly AiVaultSession[],
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
    preserveStructuredSessions
  }: AiVaultSessionFilterState
): ReturnType<typeof mergeAiVaultConversationSearch> | null {
  return useMemo(
    () =>
      enabled
        ? mergeAiVaultConversationSearch(indexed, history, {
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
        : null,
    [
      enabled,
      indexed,
      history,
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
    ]
  )
}
