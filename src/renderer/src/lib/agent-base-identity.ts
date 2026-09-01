// The renderer's single answer to "which built-in harness is this pane running?".
//
// Why this is centralized: `TuiAgent` is a union of built-in ids and custom ids,
// so `agent === 'codex'` type-checks against either — a custom Codex agent
// silently compares false and drops out of every built-in-keyed decision. The
// registries downstream (codex account-switch restart, synthetic title profiles,
// interrupt inference) are all keyed on `BuiltInTuiAgent`, so each of them needs
// the base, and each one resolving it locally is how they drifted apart.
//
// Read-side only. Neither accessor may grant launch, base-harness, or mutation
// authority — `resolveTuiAgentBaseAgent` / `getAgentIdentity` stay the
// authorities there.

import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { AgentType } from '../../../shared/agent-status-types'
import type { BuiltInTuiAgent, TuiAgent } from '../../../shared/tui-agent'
import { parseCustomTuiAgentId, resolveTuiAgentBaseAgent } from '../../../shared/custom-tui-agents'
import { useAppStore } from '@/store'

export type AgentCatalogSettings = Pick<
  GlobalSettings,
  'customTuiAgents' | 'deletedCustomTuiAgents'
>

/**
 * The built-in base the catalog can PROVE for an owner identity.
 *
 * An id the catalog cannot answer for — including a well-formed custom id whose
 * definition and tombstone are both gone — passes through unchanged, so callers
 * keep the requested id for per-agent preferences and a hook's free-form
 * `AgentType` (`'unknown'`) survives intact. Callers that must not be left
 * holding an unclassified pane want `classifyAgentBaseIdentity` instead.
 */
export function resolveAgentBaseIdentity(
  owner: TuiAgent | undefined,
  settings: AgentCatalogSettings | null | undefined
): TuiAgent | undefined
export function resolveAgentBaseIdentity(
  owner: AgentType | undefined,
  settings: AgentCatalogSettings | null | undefined
): AgentType | undefined
export function resolveAgentBaseIdentity(
  owner: AgentType | TuiAgent | undefined,
  settings: AgentCatalogSettings | null | undefined
): AgentType | undefined {
  if (owner === undefined) {
    return undefined
  }
  return (
    resolveTuiAgentBaseAgent(
      owner as TuiAgent,
      settings?.customTuiAgents,
      settings?.deletedCustomTuiAgents
    ) ?? owner
  )
}

/**
 * The built-in base an owner identity CLASSIFIES as: proven by the catalog, and
 * failing that read from the id's own syntax.
 *
 * Why the extra fallback, and why it is opt-in: for a decision like "is this pane
 * running Codex", leaving a custom id unclassified is the damaging answer — the
 * pane keeps taking keystrokes on the account the user switched away from. But
 * that trade is wrong where an unresolvable id should stay itself, so only the
 * classification callers take it. Syntax cannot mint launch authority; it only
 * names the harness the pane is already running.
 *
 * A `TuiAgent` in yields a `BuiltInTuiAgent` out, and soundly: a built-in
 * resolves to itself and a well-formed custom id resolves through the catalog or
 * its syntax. The passthrough is reachable only by a value that lies about its
 * type, which the free-form `AgentType` overload covers.
 */
export function classifyAgentBaseIdentity(
  owner: TuiAgent | undefined,
  settings: AgentCatalogSettings | null | undefined
): BuiltInTuiAgent | undefined
export function classifyAgentBaseIdentity(
  owner: AgentType | undefined,
  settings: AgentCatalogSettings | null | undefined
): AgentType | undefined
export function classifyAgentBaseIdentity(
  owner: AgentType | TuiAgent | undefined,
  settings: AgentCatalogSettings | null | undefined
): AgentType | undefined {
  if (owner === undefined) {
    return undefined
  }
  const proven = resolveAgentBaseIdentity(owner as AgentType, settings)
  return proven === owner ? (parseCustomTuiAgentId(owner)?.baseAgent ?? owner) : proven
}

/** Store-backed `resolveAgentBaseIdentity` for call sites with no settings in hand. */
export function resolvePaneOwnerBaseAgent(owner: TuiAgent | undefined): TuiAgent | undefined
export function resolvePaneOwnerBaseAgent(owner: AgentType | undefined): AgentType | undefined
export function resolvePaneOwnerBaseAgent(
  owner: AgentType | TuiAgent | undefined
): AgentType | undefined {
  return resolveAgentBaseIdentity(owner as AgentType | undefined, useAppStore.getState().settings)
}
