import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../../agent-status/contracts/agent-status-types'
import type { AgentSubagentSnapshot } from '../../../agent-status/contracts/agent-status-subagent-snapshot'
import type { AgentChildWorkLiveness } from '../../../agent-status/child-work/agent-status-child-work-liveness'
import { foldAgentLeadStatus } from '../../../agent-status/lifecycle/agent-lead-status-fold'
import type { HookListenerState } from '../../listener-state'
import {
  reconcileAntigravityActiveSubagents,
  type AntigravityPaneChildState
} from './antigravity-subagent-roster'

export function buildAntigravityFoldedStatusPayload(
  state: HookListenerState,
  paneKey: string,
  paneState: AntigravityPaneChildState,
  now: number,
  options?: { subagents?: AgentSubagentSnapshot[] }
): ParsedAgentStatusPayload | null {
  const subagents = options?.subagents ?? reconcileAntigravityActiveSubagents(paneState, now)
  const leadState = paneState.leadState ?? 'working'
  const leadStateStartedAt = paneState.leadStateStartedAt ?? now
  const hasWaitingSubagent = subagents.some((subagent) => subagent.state === 'waiting')
  const hasCommands = (paneState.commands?.size ?? 0) > 0
  const childrenEnded = paneState.helpersIdleAt !== undefined
  const liveness: AgentChildWorkLiveness = hasWaitingSubagent
    ? 'waiting'
    : paneState.children.size > 0 ||
        childrenEnded ||
        (leadState === 'done' && paneState.awaitingInitialHelperDiscovery !== undefined)
      ? 'working'
      : hasCommands
        ? 'monitoring'
        : null
  const folded = foldAgentLeadStatus({ leadState, childWorkLiveness: liveness })
  const snapshot = state.lastToolByPaneKey.get(paneKey)
  const prompt = state.lastPromptByPaneKey.get(paneKey) ?? ''

  return normalizeAgentStatusPayload({
    state: folded.stateName,
    ...(folded.workingMode ? { workingMode: folded.workingMode } : {}),
    prompt,
    agentType: 'antigravity',
    model: paneState.leadModel,
    toolName: snapshot?.toolName,
    toolInput: snapshot?.toolInput,
    interactivePrompt: snapshot?.interactivePrompt,
    lastAssistantMessage: snapshot?.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot?.lastAssistantMessageIsToolOutput,
    subagents: subagents.length > 0 ? subagents : undefined,
    mainAgent: { state: leadState, stateStartedAt: leadStateStartedAt }
  })
}
