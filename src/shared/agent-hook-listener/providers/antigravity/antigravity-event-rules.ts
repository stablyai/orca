// Antigravity lifecycle predicates shared by normalization, child tracking, and result discovery.

export function isAntigravityStopStillBusy(hookPayload: Record<string, unknown>): boolean {
  return hookPayload.fullyIdle === false || hookPayload.fully_idle === false
}

export function isAntigravityFeedbackTool(toolName: string | undefined): boolean {
  return toolName === 'ask_question' || toolName === 'ask_permission'
}

export function isAntigravitySubagentTool(toolName: string | undefined): boolean {
  return (
    toolName === 'invoke_subagent' ||
    toolName === 'send_message' ||
    toolName === 'manage_subagents' ||
    toolName === 'swarm' ||
    toolName === 'swarm_wait' ||
    toolName === 'read_board' ||
    toolName === 'run_workflow'
  )
}

export function isRecognizedAntigravityEvent(eventName: unknown): boolean {
  return (
    eventName === 'PreInvocation' ||
    eventName === 'PostInvocation' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'Stop'
  )
}

export function resolveSimpleAntigravityEventState(
  eventName: unknown,
  toolName: string | undefined,
  stopStillBusy: boolean
): 'working' | 'waiting' | 'done' | null {
  if (eventName === 'PreToolUse' && isAntigravityFeedbackTool(toolName)) {
    return 'waiting'
  }
  if (eventName === 'Stop') {
    return stopStillBusy ? 'working' : 'done'
  }
  return isRecognizedAntigravityEvent(eventName) ? 'working' : null
}
