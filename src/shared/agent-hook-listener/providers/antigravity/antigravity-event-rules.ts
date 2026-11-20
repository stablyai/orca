// Antigravity lifecycle predicates shared by normalization, child tracking, and result discovery.

export function isAntigravityStopStillBusy(hookPayload: Record<string, unknown>): boolean {
  return hookPayload.fullyIdle === false || hookPayload.fully_idle === false
}

export function isAntigravityFeedbackTool(toolName: string | undefined): boolean {
  return toolName === 'ask_question' || toolName === 'ask_permission'
}

export function isAntigravityHelperSpawnTool(toolName: string | undefined): boolean {
  return toolName === 'invoke_subagent' || toolName === 'swarm' || toolName === 'run_workflow'
}

/** A tool call that starts subagents; `swarm` does only for `add`, not for status, kill or messages. */
export function isAntigravityHelperSpawnCall(toolName: string | undefined, args: unknown): boolean {
  return toolName === 'swarm'
    ? typeof args === 'object' && args !== null && (args as { action?: unknown }).action === 'add'
    : isAntigravityHelperSpawnTool(toolName)
}

export function isAntigravitySubagentTool(toolName: string | undefined): boolean {
  return (
    isAntigravityHelperSpawnTool(toolName) ||
    toolName === 'send_message' ||
    toolName === 'manage_subagents' ||
    toolName === 'swarm_wait' ||
    toolName === 'read_board'
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
