import type { AgentProviderSessionMetadata } from '../../agent-session/lifecycle/agent-session-resume'
import { readClaudePermissionMode } from '../../agent-session/lifecycle/provider-session-live-settings'
import { readFirstString } from '../interactive-tool'
import type { AgentHookSource } from '../transport/agent-hook-relay'

const HOOK_PERMISSION_MODE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

export function isSubagentHookPayload(hookPayload: Record<string, unknown>): boolean {
  return (
    readFirstString(hookPayload, ['agent_id', 'agentId', 'parent_agent_id', 'parentAgentId']) !==
    undefined
  )
}

function normalizeNonClaudePermissionMode(value: unknown): string | undefined {
  if (typeof value !== 'string' || !HOOK_PERMISSION_MODE_RE.test(value)) {
    return undefined
  }
  return value === 'yolo' ||
    value === 'bypass' ||
    value === 'bypass_permissions' ||
    value === 'bypass-permissions'
    ? 'bypassPermissions'
    : value
}

export function readHookReportedPermissionMode(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>
): string | undefined {
  // Why skip subagents: their hooks name the parent session but report the subagent's own mode.
  if (isSubagentHookPayload(hookPayload)) {
    return undefined
  }
  return source === 'claude'
    ? readClaudePermissionMode(hookPayload.permission_mode)
    : normalizeNonClaudePermissionMode(hookPayload.permission_mode ?? hookPayload.permissionMode)
}

export function isFreshSessionStartHook(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>,
  eventName: unknown
): boolean {
  if (source === 'claude') {
    return (
      hookPayload.hook_event_name === 'SessionStart' &&
      (hookPayload.source === 'startup' || hookPayload.source === 'resume')
    )
  }
  return (
    eventName === 'SessionStart' ||
    eventName === 'session_start' ||
    eventName === 'sessionStart' ||
    eventName === 'on_session_start' ||
    eventName === 'agentSpawn'
  )
}

/** Hooks and process argv record a session's permission mode; later events of one process keep the last one. */
export function readLivePermissionMode(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>,
  eventName: unknown,
  continued: AgentProviderSessionMetadata | undefined,
  previousEnded: boolean
): string | undefined {
  const reported = readHookReportedPermissionMode(source, hookPayload)
  // A fresh process may run with other flags than the last one on this conversation.
  const freshStart = previousEnded || isFreshSessionStartHook(source, hookPayload, eventName)
  return reported ?? (freshStart ? undefined : continued?.permissionMode)
}
