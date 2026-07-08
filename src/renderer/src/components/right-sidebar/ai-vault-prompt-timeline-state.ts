import { useMemo } from 'react'
import {
  AI_VAULT_AGENTS,
  type AiVaultScope,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { filterAiVaultSessions } from './ai-vault-session-filters'
import { buildPromptTimeline, type AiVaultPromptDateGroup } from './ai-vault-prompt-timeline'
import type { AiVaultSessionProject } from './ai-vault-session-projects'

// Derives the "My prompts" timeline: main-agent conversations for the current
// scope, flattened to a query-filtered, date-grouped prompt list. Runs only
// while the prompts view is active to keep the sessions view cheap.
export function useAiVaultPromptTimeline(args: {
  enabled: boolean
  sessions: readonly AiVaultSession[]
  query: string
  scope: AiVaultScope
  activeWorktreePaths: readonly string[]
  activeProjectKey?: string | null
  sessionProjectById?: ReadonlyMap<string, AiVaultSessionProject>
  projectLabelByKey?: ReadonlyMap<string, string>
}): { groups: AiVaultPromptDateGroup[]; promptCount: number; shownCount: number } {
  const {
    enabled,
    sessions,
    query,
    scope,
    activeWorktreePaths,
    activeProjectKey,
    sessionProjectById,
    projectLabelByKey
  } = args

  const mainAgentSessions = useMemo(
    () =>
      enabled
        ? filterAiVaultSessions(sessions, {
            query: '',
            // The agent toggle is a sessions-view control (hidden here); the
            // timeline is Claude-only anyway, so never filter it out.
            agents: AI_VAULT_AGENTS,
            scope,
            sort: 'updated',
            activeWorktreePaths,
            activeProjectKey,
            sessionProjectById,
            projectLabelByKey,
            hideEmptySessions: false,
            mainAgentOnly: true
          })
        : [],
    [
      activeProjectKey,
      activeWorktreePaths,
      enabled,
      projectLabelByKey,
      scope,
      sessionProjectById,
      sessions
    ]
  )

  const { groups, promptCount } = useMemo(() => {
    if (!enabled) {
      return { groups: [] as AiVaultPromptDateGroup[], promptCount: 0 }
    }
    const result = buildPromptTimeline(mainAgentSessions, query, Date.now())
    return { groups: result.groups, promptCount: result.total }
  }, [enabled, mainAgentSessions, query])

  const shownCount = useMemo(
    () => groups.reduce((total, group) => total + group.items.length, 0),
    [groups]
  )

  return { groups, promptCount, shownCount }
}
