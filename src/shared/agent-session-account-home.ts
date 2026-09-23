// The account root a session is pinned to, and its durable-record guard.

import {
  MAX_ID_LENGTH,
  MAX_PATH_LENGTH,
  isBoundedString
} from './agent-session-record-field-limits'

/** Account root pinned at launch by the account selector, so a resume cannot drift to another login. */
export type AgentSessionAccountHome = {
  variable: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'
  /** Host-resolved absolute path in the execution host's own path syntax. */
  path: string
  /** Present when a project-group binding chose this home. Host-set; a client may never supply it. */
  binding?: { kind: 'project-group'; groupId: string }
}

function isAccountHomeBinding(value: unknown): value is AgentSessionAccountHome['binding'] {
  if (value === undefined) {
    return true
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'kind' in value &&
    value.kind === 'project-group' &&
    'groupId' in value &&
    isBoundedString(value.groupId, MAX_ID_LENGTH)
  )
}

export function isAgentSessionAccountHome(value: unknown): value is AgentSessionAccountHome {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'variable' in value &&
    (value.variable === 'CLAUDE_CONFIG_DIR' || value.variable === 'CODEX_HOME') &&
    'path' in value &&
    isBoundedString(value.path, MAX_PATH_LENGTH) &&
    isAccountHomeBinding('binding' in value ? value.binding : undefined)
  )
}
