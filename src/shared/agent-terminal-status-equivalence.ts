import type { ParsedAgentStatusPayload } from './agent-status-types'

/** Whether a terminal status is the same hook status with only hook-owned metadata omitted.
 *
 *  `preserveActiveTurnStamp` marks the cached hook payload as the still-open turn the OSC ping
 *  belongs to: OSC carries neither the turn stamp nor the assistant tail, so their absence must
 *  read as "omitted", not "changed", or the ping overwrites a live turn's stamp. */
export function terminalStatusPayloadMatchesHook(
  cachedHookPayload: ParsedAgentStatusPayload,
  terminalPayload: ParsedAgentStatusPayload,
  preserveActiveTurnStamp = false
): boolean {
  // OSC never carries model/children; compare only fields its protocol owns.
  return (
    cachedHookPayload.state === terminalPayload.state &&
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
