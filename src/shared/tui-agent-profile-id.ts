import type { TuiAgentProfileId } from './types'

export const TUI_AGENT_PROFILE_ID_PREFIX = 'agent-profile:'

const PROFILE_ID_BODY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}$/i

export function isTuiAgentProfileId(value: unknown): value is TuiAgentProfileId {
  if (typeof value !== 'string' || !value.startsWith(TUI_AGENT_PROFILE_ID_PREFIX)) {
    return false
  }
  return PROFILE_ID_BODY_PATTERN.test(value.slice(TUI_AGENT_PROFILE_ID_PREFIX.length))
}
