import {
  buildPaletteTranscriptIndex,
  type PaletteTranscriptIndex,
  type PaletteTranscriptState
} from './palette-transcript-structured-tabs'
import {
  AiVaultSearchEligibleSessionsSchema,
  SEARCH_ELIGIBLE_PANES_MAX,
  type AiVaultSearchEligibleSessions
} from '../../../../shared/ai-vault-search-eligible-sessions'
import { isAiVaultAgent } from '../../../../shared/ai-vault-types'
import { agentEntryPromptCandidates } from '../../../../shared/ai-vault-session-prompt-match'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'
import {
  resolveOriginalPaneTarget,
  type OriginalPaneState
} from '../right-sidebar/ai-vault-original-pane'

/** Pane resolution must use the same workspace and host scope as retrieval. */
export function paletteTranscriptPaneState(
  state: OriginalPaneState,
  workspaces: readonly Worktree[],
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree'],
  executionHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): PaletteTranscriptState {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id))
  const tabsByWorktree = Object.fromEntries(
    Object.entries(state.tabsByWorktree)
      .filter(([workspaceId]) => workspaceIds.has(workspaceId))
      .map(([workspaceId, tabs]) => {
        const foreignTabIds = new Set(
          (unifiedTabsByWorktree[workspaceId] ?? [])
            .filter(
              (tab) =>
                tab.contentType === 'terminal' &&
                tab.executionHostId &&
                tab.executionHostId !== executionHostId
            )
            .map((tab) => tab.entityId)
        )
        return [workspaceId, tabs.filter((tab) => !foreignTabIds.has(tab.id))]
      })
  )
  return {
    ...state,
    agentStatusByPaneKey: Object.fromEntries(
      Object.entries(state.agentStatusByPaneKey).filter(
        ([, entry]) => !entry.worktreeId || workspaceIds.has(entry.worktreeId)
      )
    ),
    retainedAgentsByPaneKey: Object.fromEntries(
      Object.entries(state.retainedAgentsByPaneKey).filter(
        ([, retained]) => retained && workspaceIds.has(retained.worktreeId)
      )
    ),
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      Object.entries(state.sleepingAgentSessionsByPaneKey).filter(
        ([, entry]) => entry && workspaceIds.has(entry.worktreeId)
      )
    ),
    tabsByWorktree,
    unifiedTabsByWorktree: Object.fromEntries(
      Object.entries(unifiedTabsByWorktree).filter(([workspaceId]) => workspaceIds.has(workspaceId))
    )
  }
}

/** Compact projection of the original-pane lookup, including its legacy prompt fallback. */
export function paletteTranscriptEligibility(
  state: PaletteTranscriptState,
  index: PaletteTranscriptIndex = buildPaletteTranscriptIndex(state)
): AiVaultSearchEligibleSessions | null {
  const providers = new Map<string, AiVaultSearchEligibleSessions['providers'][number]>()
  const promptsByAgent = new Map<string, AiVaultSearchEligibleSessions['prompts']>()
  const entries = [
    ...Object.values(state.agentStatusByPaneKey).map((entry) => ({
      entry,
      agent: entry.agentType
    })),
    ...Object.values(state.retainedAgentsByPaneKey).flatMap((retained) =>
      retained
        ? [
            {
              entry: {
                ...retained.entry,
                worktreeId: retained.worktreeId,
                tabId: retained.entry.tabId ?? retained.tab.id
              },
              agent: retained.agentType
            }
          ]
        : []
    ),
    ...Object.values(state.sleepingAgentSessionsByPaneKey).flatMap((entry) =>
      entry ? [{ entry, agent: entry.agent }] : []
    )
  ]
  for (const { entry, agent } of entries) {
    if (
      !isAiVaultAgent(agent) ||
      !resolveOriginalPaneTarget({
        state,
        paneKey: entry.paneKey,
        worktreeIdHint: entry.worktreeId,
        tabIdHint: entry.tabId
      })
    ) {
      continue
    }
    if (entry.providerSession) {
      if (!entry.providerSession.id || entry.providerSession.id.length > 512) {
        continue
      }
      const provider = { agent, sessionId: entry.providerSession.id }
      providers.set(JSON.stringify([provider.agent, provider.sessionId]), provider)
    } else if (entry.providerSession === undefined && 'prompt' in entry) {
      const candidates = agentEntryPromptCandidates(entry)
      if (candidates.length) {
        const prompts = promptsByAgent.get(agent) ?? []
        prompts.push({ agent, prompts: candidates })
        promptsByAgent.set(agent, prompts)
      }
    }
  }
  for (const { agent, sessionId } of index.structuredTabs) {
    providers.set(JSON.stringify([agent, sessionId]), { agent, sessionId })
  }
  let eligible: AiVaultSearchEligibleSessions = {
    providers: [...providers.values()].slice(0, SEARCH_ELIGIBLE_PANES_MAX),
    prompts: []
  }
  for (const prompts of promptsByAgent.values()) {
    // Drop an entire agent's fallback rather than turn an ambiguous target into a unique one.
    const parsed = AiVaultSearchEligibleSessionsSchema.safeParse({
      providers: eligible.providers,
      prompts: [...eligible.prompts, ...prompts]
    })
    if (parsed.success) {
      eligible = parsed.data
    }
  }
  return eligible
}
