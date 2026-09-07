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

/** Completion signal for answer surfaces that write directly to the runtime
 *  instead of xterm (notably native chat). The same fresh-status baseline is
 *  used, so a real hook that wins the race prevents the fallback IPC. */
export function inferQuestionAnsweredFromCurrentStatus(
  deps: AgentQuestionAnsweredInferenceDeps
): boolean {
  return inferQuestionAnsweredFromEntry(deps, deps.getStatusEntry())
}

/** Sibling of the interrupt inference for a hook Claude never sends: answering
 *  an AskUserQuestion emits no event, so the submit keystroke into the waiting
 *  pane is the only "question dealt with" signal. Unlike interrupts there is
 *  no expected real hook to settle for, so the inference fires immediately —
 *  the main process re-validates the baseline, so a racing hook always wins. */
export function createAgentQuestionAnsweredInference({
  paneKey,
  getStatusEntry,
  inferQuestionAnswered,
  now = () => Date.now()
}: AgentQuestionAnsweredInferenceDeps): AgentQuestionAnsweredInference {
  return {
    observeSentTerminalInput(data) {
      // Why: ordinary terminal input is the hot path. Reject it with one
      // constant-time membership check before reading Zustand or parsing the
      // bounded interactive-prompt JSON.
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
