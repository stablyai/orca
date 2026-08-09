import {
  AGENT_PROMPT_SUBMISSION_HISTORY_MAX,
  type AgentPromptSubmissionOccurrence
} from '../../../../shared/agent-status-types'

export function appendAgentPromptSubmission(
  existing: AgentPromptSubmissionOccurrence[] | undefined,
  occurrence: AgentPromptSubmissionOccurrence | undefined
): AgentPromptSubmissionOccurrence[] | undefined {
  if (!occurrence) {
    return existing
  }
  const previous = existing ?? []
  if (
    previous.some(
      (candidate) =>
        candidate.streamId === occurrence.streamId && candidate.sequence === occurrence.sequence
    )
  ) {
    return existing
  }
  return [...previous, occurrence].slice(-AGENT_PROMPT_SUBMISSION_HISTORY_MAX)
}
