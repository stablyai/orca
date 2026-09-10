import type { AgentStateHistoryEntry, AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import { normalizePromptField } from '../../../shared/agent-status-field-normalization'

type AgentStatusRunCandidate = Pick<AgentStateHistoryEntry, 'state' | 'prompt' | 'providerSession'>

export function createAutomationAgentStatusMatcher(prompt: string) {
  let targetProviderSession: AgentProviderSessionMetadata | undefined
  const runPrompt = normalizePromptField(prompt)
  const promptMatchesRun = (candidatePrompt: string | undefined): boolean => {
    if (!runPrompt) {
      return true
    }
    const trimmed = candidatePrompt?.trim() ?? ''
    return trimmed.length > 0 && trimmed === runPrompt
  }
  const maybeCaptureTargetProviderSession = (
    candidate: Pick<AgentStatusEntry, 'state' | 'prompt' | 'providerSession'>
  ): void => {
    if (targetProviderSession || candidate.state === 'done' || !candidate.providerSession) {
      return
    }
    if (promptMatchesRun(candidate.prompt)) {
      targetProviderSession = candidate.providerSession
    }
  }
  const candidateBelongsToRun = (
    agentType: string | undefined,
    candidate: AgentStatusRunCandidate
  ): boolean => {
    if (targetProviderSession) {
      return (
        candidate.providerSession !== undefined &&
        agentProviderSessionsEqual(agentType, candidate.providerSession, targetProviderSession)
      )
    }
    if (candidate.state !== 'done' && candidate.providerSession?.transcriptPath) {
      return true
    }
    return promptMatchesRun(candidate.prompt)
  }

  return {
    candidateBelongsToRun,
    maybeCaptureTargetProviderSession,
    promptMatchesRun
  }
}

export function automationAgentStateHistoryEntriesEqual(
  agentType: string | undefined,
  left: AgentStateHistoryEntry,
  right: AgentStateHistoryEntry
): boolean {
  return (
    left.state === right.state &&
    left.prompt === right.prompt &&
    left.startedAt === right.startedAt &&
    left.interrupted === right.interrupted &&
    agentProviderSessionsEqual(agentType, left.providerSession, right.providerSession)
  )
}

export function getAutomationAgentStateHistoryOverlap(
  agentType: string | undefined,
  previous: AgentStateHistoryEntry[],
  current: AgentStateHistoryEntry[]
): number {
  for (let overlap = Math.min(previous.length, current.length); overlap > 0; overlap -= 1) {
    const previousOffset = previous.length - overlap
    if (
      current
        .slice(0, overlap)
        .every((entry, index) =>
          automationAgentStateHistoryEntriesEqual(
            agentType,
            entry,
            previous[previousOffset + index]
          )
        )
    ) {
      return overlap
    }
  }
  return 0
}
