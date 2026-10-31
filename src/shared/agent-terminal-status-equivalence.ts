import { mainAgentStatusEqual, type ParsedAgentStatusPayload } from './agent-status-types'

/** OSC omits hook turn stamps/assistant tails. preserveActiveTurnStamp treats those as omitted for the still-open turn, avoiding a ping overwriting live hook evidence. */
export function terminalStatusPayloadMatchesHook(
  cachedHookPayload: ParsedAgentStatusPayload,
  terminalPayload: ParsedAgentStatusPayload,
  preserveActiveTurnStamp = false
): boolean {
  // OSC never carries model/children; compare only fields its protocol owns.
  return (
    cachedHookPayload.state === terminalPayload.state &&
    (terminalPayload.mainAgent === undefined ||
      mainAgentStatusEqual(cachedHookPayload.mainAgent, terminalPayload.mainAgent)) &&
    // OSC never carries workingMode either; only a stated mismatch breaks equivalence.
    (terminalPayload.workingMode === undefined ||
      cachedHookPayload.workingMode === terminalPayload.workingMode) &&
    cachedHookPayload.prompt === terminalPayload.prompt &&
    cachedHookPayload.agentType === terminalPayload.agentType &&
    cachedHookPayload.toolName === terminalPayload.toolName &&
    cachedHookPayload.toolInput === terminalPayload.toolInput &&
    cachedHookPayload.interactivePrompt === terminalPayload.interactivePrompt &&
    (cachedHookPayload.lastAssistantMessage === terminalPayload.lastAssistantMessage ||
      (preserveActiveTurnStamp && terminalPayload.lastAssistantMessage === undefined)) &&
    cachedHookPayload.interrupted === terminalPayload.interrupted &&
    // A session-boundary done must never dedupe against a real done (STA-3386).
    cachedHookPayload.sessionBoundary === terminalPayload.sessionBoundary &&
    (cachedHookPayload.turnCompletedAt === terminalPayload.turnCompletedAt ||
      (preserveActiveTurnStamp && terminalPayload.turnCompletedAt === undefined))
  )
}
