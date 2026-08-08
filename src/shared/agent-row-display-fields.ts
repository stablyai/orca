import type { AgentRowDisplayField } from './types'

/** Canonical order for sidebar/dashboard agent-row optional fields. */
export const AGENT_ROW_DISPLAY_FIELDS = [
  'provider-icon',
  'secondary-status',
  'model',
  'relative-time'
] as const satisfies readonly AgentRowDisplayField[]

/** All fields on by default so existing layouts stay unchanged. */
export const DEFAULT_AGENT_ROW_DISPLAY_FIELDS: AgentRowDisplayField[] = [
  ...AGENT_ROW_DISPLAY_FIELDS
]

export function normalizeAgentRowDisplayFields(
  fields: readonly unknown[] | null | undefined
): AgentRowDisplayField[] {
  const source = Array.isArray(fields) ? fields : DEFAULT_AGENT_ROW_DISPLAY_FIELDS
  const normalized: AgentRowDisplayField[] = []
  for (const field of AGENT_ROW_DISPLAY_FIELDS) {
    if (source.includes(field)) {
      normalized.push(field)
    }
  }
  return normalized
}

export function agentRowShowsField(
  fields: readonly AgentRowDisplayField[],
  field: AgentRowDisplayField
): boolean {
  return fields.includes(field)
}
