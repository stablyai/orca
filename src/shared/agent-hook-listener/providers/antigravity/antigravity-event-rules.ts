// Antigravity lifecycle predicates shared by normalization, child tracking, and result discovery.
import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'

export const ANTIGRAVITY_PARENT_WAKE_GRACE_MS = 2000

export function isAntigravityStopStillBusy(hookPayload: Record<string, unknown>): boolean {
  return hookPayload.fullyIdle === false || hookPayload.fully_idle === false
}

export function isAntigravityFeedbackTool(toolName: string | undefined): boolean {
  return toolName === 'ask_question' || toolName === 'ask_permission'
}

export function isAntigravityHelperSpawnCall(toolName: string | undefined, args: unknown): boolean {
  return (
    toolName === 'invoke_subagent' ||
    (toolName === 'swarm' && isRecord(args) && args.action === 'add')
  )
}

export function isAntigravityAgentCoordinationTool(toolName: string | undefined): boolean {
  return (
    toolName === 'invoke_subagent' ||
    toolName === 'swarm' ||
    toolName === 'run_workflow' ||
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
