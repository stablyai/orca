// Custom TUI agent identity accessors over the normalized catalog. This module is
// the single authority for what a well-formed custom agent is; static behavior
// registries stay keyed by BuiltInTuiAgent and dynamic ids resolve through
// `getAgentIdentity` before any registry lookup. Identity, field validation, and
// catalog normalization live in the re-exported sibling modules.

import type {
  BuiltInTuiAgent,
  CustomTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent,
  TuiAgent
} from './types'
import { isBuiltInTuiAgent, TUI_AGENT_CONFIG, type TuiAgentConfig } from './tui-agent-config'
import { isCustomTuiAgentId } from './custom-tui-agent-identity'
import type { AgentCatalog } from './agent-catalog-normalization'

export * from './custom-tui-agent-identity'
export * from './custom-tui-agent-fields'
export * from './agent-catalog-normalization'

export type AgentIdentity =
  | { kind: 'built-in'; requestedAgent: BuiltInTuiAgent; baseAgent: BuiltInTuiAgent }
  | {
      kind: 'custom'
      requestedAgent: CustomTuiAgentId
      baseAgent: BuiltInTuiAgent
      definition: CustomTuiAgent
    }
  | {
      kind: 'deleted'
      requestedAgent: CustomTuiAgentId
      baseAgent: BuiltInTuiAgent
      tombstone: DeletedCustomTuiAgent
    }

/** The one dynamic accessor used outside the resolver. Returns null for unknown
 *  ids (including well-formed custom ids with neither definition nor tombstone). */
export function getAgentIdentity(agent: TuiAgent, catalog: AgentCatalog): AgentIdentity | null {
  if (isBuiltInTuiAgent(agent)) {
    return { kind: 'built-in', requestedAgent: agent, baseAgent: agent }
  }
  if (!isCustomTuiAgentId(agent)) {
    return null
  }
  const definition = catalog.liveById.get(agent)
  if (definition) {
    return {
      kind: 'custom',
      requestedAgent: agent,
      baseAgent: definition.baseAgent,
      definition
    }
  }
  const tombstone = catalog.tombstonesById.get(agent)
  if (tombstone) {
    return {
      kind: 'deleted',
      requestedAgent: agent,
      baseAgent: tombstone.baseAgent,
      tombstone
    }
  }
  return null
}

/** Catalog-validated base lookup for surfaces that only carry raw settings arrays
 *  (renderer store, mobile parity tables). Returns the built-in itself, the proven
 *  base of a live/repair/tombstoned custom id, or null for unknown ids — never a
 *  base derived from id syntax alone. */
export function resolveTuiAgentBaseAgent(
  agent: TuiAgent | null | undefined,
  customTuiAgents?: readonly CustomTuiAgent[] | null,
  deletedCustomTuiAgents?: readonly DeletedCustomTuiAgent[] | null
): BuiltInTuiAgent | null {
  if (!agent) {
    return null
  }
  if (isBuiltInTuiAgent(agent)) {
    return agent
  }
  if (!isCustomTuiAgentId(agent)) {
    return null
  }
  const live = customTuiAgents?.find((candidate) => candidate?.id === agent)
  if (live && isBuiltInTuiAgent(live.baseAgent)) {
    return live.baseAgent
  }
  const tombstone = deletedCustomTuiAgents?.find((candidate) => candidate?.id === agent)
  if (tombstone && isBuiltInTuiAgent(tombstone.baseAgent)) {
    return tombstone.baseAgent
  }
  return null
}

// Legacy startup paths must resolve custom ids through the catalog first; a
// custom id reaching here is a programming error, never a launchable state.
export function requireBuiltInTuiAgentConfig(agent: TuiAgent): TuiAgentConfig {
  if (!isBuiltInTuiAgent(agent)) {
    throw new Error('legacy agent startup path requires a built-in agent id')
  }
  return TUI_AGENT_CONFIG[agent]
}

/** Base accessor for the built-in-only static config (oracle 16): resolve an
 *  agent id — built-in OR custom — to its base harness's TuiAgentConfig. A custom
 *  agent reads its base's config; an unresolvable or tombstoned-without-base id
 *  returns null. Callers must never index TUI_AGENT_CONFIG with a raw TuiAgent,
 *  because a custom id would silently yield undefined (noImplicitAny hides it). */
export function resolveTuiAgentConfig(
  agent: TuiAgent | null | undefined,
  customTuiAgents?: readonly CustomTuiAgent[] | null,
  deletedCustomTuiAgents?: readonly DeletedCustomTuiAgent[] | null
): TuiAgentConfig | null {
  const base = resolveTuiAgentBaseAgent(agent, customTuiAgents, deletedCustomTuiAgents)
  return base ? TUI_AGENT_CONFIG[base] : null
}
