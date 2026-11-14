import type { AppState } from '@/store/types'
import type { AgentMainAgentStatus } from '../../../../shared/agent-status/lifecycle/main-agent-status'
import { programStatusFacetContent } from '../../../../shared/program-status/facet'

const AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS = 30_000

function mainAgentKey(mainAgent: AgentMainAgentStatus | undefined) {
  return mainAgent ? [mainAgent.state, mainAgent.outcome ?? null, mainAgent.stateStartedAt] : null
}

export function serializeAgentStatusEntry(
  paneKey: string,
  entry: NonNullable<ReturnType<AppState['agentStatusByPaneKey']['get']>>
): string {
  return JSON.stringify({
    paneKey,
    paneSleep: entry.paneSleep ?? null,
    entryPaneKey: entry.paneKey,
    state: entry.state,
    workingMode: entry.workingMode ?? null,
    prompt: entry.prompt,
    updatedAtBucket: Math.floor(entry.updatedAt / AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS),
    stateStartedAt: entry.stateStartedAt,
    turnStartedAt: entry.turnStartedAt ?? null,
    turnEndedAt: entry.turnEndedAt ?? null,
    turnEndDisposition: entry.turnEndDisposition ?? null,
    agentType: entry.agentType ?? null,
    terminalTitle: entry.terminalTitle ?? null,
    stateHistory: entry.stateHistory.map((history) => ({
      state: history.state,
      prompt: history.prompt,
      startedAt: history.startedAt,
      interrupted: history.interrupted ?? null,
      mainAgent: mainAgentKey(history.mainAgent)
    })),
    toolName: entry.toolName ?? null,
    toolInput: entry.toolInput ?? null,
    // Include the prompt so a newly captured question re-fires mobile publication.
    interactivePrompt: entry.interactivePrompt ?? null,
    lastAssistantMessage: entry.lastAssistantMessage ?? null,
    lastAssistantMessageIsToolOutput: entry.lastAssistantMessageIsToolOutput ?? null,
    interrupted: entry.interrupted ?? null,
    // A failure changes the verdict and leaves `interrupted` as it was.
    mainAgent: mainAgentKey(entry.mainAgent),
    programStatus: entry.programStatus ? programStatusFacetContent(entry.programStatus) : null,
    // Undefined drops out of the JSON; null (host can name it, has not yet) stays distinct.
    orcaSessionId: entry.orcaSessionId
  })
}

/** Equality token is advanced at the accepted-key publication seam, never by rescanning rows. */
export function buildRuntimeMobileAgentStatusProjection(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey']
): object {
  return agentStatusByPaneKey.mobileToken
}
