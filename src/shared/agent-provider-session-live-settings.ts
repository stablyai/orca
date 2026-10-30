import { readAgentEffortLevel } from './agent-effort-level'
import type { AgentProviderSessionMetadata } from './agent-session-resume'

// Why a shape, not Claude's mode list: a mode a newer Claude adds must still round-trip.
export const CLAUDE_PERMISSION_MODE = /^[A-Za-z]{1,32}$/

export function readClaudePermissionMode(value: unknown): string | undefined {
  return typeof value === 'string' && CLAUDE_PERMISSION_MODE.test(value) ? value : undefined
}

/** Session settings a resume replays; persisted and relayed records cross trust boundaries too. */
export function readProviderSessionLiveSettings(
  record: Record<string, unknown>
): Pick<AgentProviderSessionMetadata, 'effort' | 'permissionMode'> {
  const effort = readAgentEffortLevel(record.effort)
  const permissionMode = readClaudePermissionMode(record.permissionMode)
  return { ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}) }
}
