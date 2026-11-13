import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentStatusFresh as isExplicitAgentStatusFresh
} from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  isAskUserQuestionTool,
  isPotentialQuestionAnsweredSubmitInput,
  isQuestionAnsweredSubmitInput,
  type AgentQuestionAnsweredInferenceRequest
} from '../../../../../../shared/agent-status/lifecycle/agent-question-answered-intent'
import {
  CODEX_ASYNC_QUESTION_TOOL,
  isCodexSkipQuestionInput
} from '../../../../../../shared/codex-async-question-input'

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
  entry: AgentStatusEntry | undefined,
  /** Codex async questions resolve only by skip; their answers arrive as hooks. */
  codexSkip = false
): boolean {
  const now = deps.now ?? Date.now
  if (
    !entry ||
    entry.state !== 'waiting' ||
    !(codexSkip
      ? entry.agentType === 'codex' && entry.toolName === CODEX_ASYNC_QUESTION_TOOL
      : entry.agentType === 'claude' && isAskUserQuestionTool(entry.toolName)) ||
    !isExplicitAgentStatusFresh(entry, now(), AGENT_STATUS_STALE_AFTER_MS)
  ) {
    return false
  }
  void deps.inferQuestionAnswered({
    paneKey: deps.paneKey,
    baselineUpdatedAt: entry.updatedAt,
    baselineStateStartedAt: entry.stateStartedAt,
    baselinePrompt: entry.prompt,
    baselineAgentType: entry.agentType,
    ...(codexSkip ? { codexSkip: true as const } : {})
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
  const deps = { paneKey, getStatusEntry, inferQuestionAnswered, now }
  return {
    observeSentTerminalInput(data) {
      // Codex's skip removes an async question in the TUI only; no hook or transcript line reports it.
      if (isCodexSkipQuestionInput(data)) {
        inferQuestionAnsweredFromEntry(deps, getStatusEntry(), true)
        return
      }
      // Reject ordinary hot-path terminal input before store reads or prompt JSON parsing.
      if (!isPotentialQuestionAnsweredSubmitInput(data)) {
        return
      }
      const entry = getStatusEntry()
      if (!entry || !isQuestionAnsweredSubmitInput(data, entry.interactivePrompt)) {
        return
      }
      inferQuestionAnsweredFromEntry(deps, entry)
    }
  }
}
