import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import {
  isAskUserQuestionTool,
  isPotentialQuestionAnsweredSubmitInput,
  isQuestionAnsweredSubmitInput,
  type AgentQuestionAnsweredInferenceRequest
} from '../../../../shared/agent-question-answered-intent'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'

export type AgentQuestionAnsweredInference = {
  observeSentTerminalInput(data: string): void
}

type AgentQuestionAnsweredInferenceDeps = {
  paneKey: string
  getStatusEntry: () => AgentStatusEntry | undefined
  inferQuestionAnswered: (
    request: AgentQuestionAnsweredInferenceRequest
  ) => boolean | Promise<boolean> | void
  now?: () => number
}

function inferQuestionAnsweredFromEntry(
  deps: AgentQuestionAnsweredInferenceDeps,
  entry: AgentStatusEntry | undefined
): boolean {
  const now = deps.now ?? Date.now
  if (
    !entry ||
    entry.state !== 'waiting' ||
    entry.agentType !== 'claude' ||
    !isAskUserQuestionTool(entry.toolName) ||
    !isExplicitAgentStatusFresh(entry, now(), AGENT_STATUS_STALE_AFTER_MS)
  ) {
    return false
  }
  void deps.inferQuestionAnswered({
    paneKey: deps.paneKey,
    baselineUpdatedAt: entry.updatedAt,
    baselineStateStartedAt: entry.stateStartedAt,
    baselinePrompt: entry.prompt,
    baselineAgentType: entry.agentType
  })
  return true
}

/** Notify direct-runtime answer surfaces such as native chat; revalidate fresh baseline so a racing hook prevents fallback IPC. */
export function inferQuestionAnsweredFromCurrentStatus(
  deps: AgentQuestionAnsweredInferenceDeps
): boolean {
  return inferQuestionAnsweredFromEntry(deps, deps.getStatusEntry())
}

/** Claude emits no AskUserQuestion-answer hook; infer immediately from submit input and let main revalidate against racing hooks. */
export function createAgentQuestionAnsweredInference({
  paneKey,
  getStatusEntry,
  inferQuestionAnswered,
  now = () => Date.now()
}: AgentQuestionAnsweredInferenceDeps): AgentQuestionAnsweredInference {
  return {
    observeSentTerminalInput(data) {
      // Reject ordinary hot-path terminal input before store reads or prompt JSON parsing.
      if (!isPotentialQuestionAnsweredSubmitInput(data)) {
        return
      }
      const entry = getStatusEntry()
      if (!entry || !isQuestionAnsweredSubmitInput(data, entry.interactivePrompt)) {
        return
      }
      inferQuestionAnsweredFromEntry({ paneKey, getStatusEntry, inferQuestionAnswered, now }, entry)
    }
  }
}
