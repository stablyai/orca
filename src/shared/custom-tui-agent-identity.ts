// Custom TUI agent id syntax: prefix, guards, decomposition, and minting. Syntax
// alone never grants launch/base authority — existence must be proven against the
// live catalog and tombstones.

import type { BuiltInTuiAgent, CustomTuiAgentId } from './types'
import { isBuiltInTuiAgent, isWellFormedCustomTuiAgentId } from './tui-agent-config'

export const CUSTOM_TUI_AGENT_ID_PREFIX = 'custom-agent:'

export function isCustomTuiAgentId(value: unknown): value is CustomTuiAgentId {
  return isWellFormedCustomTuiAgentId(value)
}

/** Syntax-only decomposition. Existence and launch/fallback authority must be
 *  proven against the live catalog/tombstones; the encoded base alone never
 *  grants a base harness. */
export function parseCustomTuiAgentId(
  value: unknown
): { baseAgent: BuiltInTuiAgent; suffix: string } | null {
  if (typeof value !== 'string' || !value.startsWith(CUSTOM_TUI_AGENT_ID_PREFIX)) {
    return null
  }
  const rest = value.slice(CUSTOM_TUI_AGENT_ID_PREFIX.length)
  const lastColon = rest.lastIndexOf(':')
  if (lastColon <= 0) {
    return null
  }
  const base = rest.slice(0, lastColon)
  const suffix = rest.slice(lastColon + 1)
  if (!isBuiltInTuiAgent(base) || !isWellFormedCustomTuiAgentId(value)) {
    return null
  }
  return { baseAgent: base, suffix }
}

/** Mint a new canonical id. Main mints ids only after full draft validation;
 *  create/duplicate RPCs never accept a client-supplied id. */
export function mintCustomTuiAgentId(baseAgent: BuiltInTuiAgent): CustomTuiAgentId {
  return `${CUSTOM_TUI_AGENT_ID_PREFIX}${baseAgent}:${crypto.randomUUID()}`
}
