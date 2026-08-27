import { findCatalogModel, getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { AGENT_HOOK_TARGETS } from './agent-hook-types'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

/** Addendum — ONE derived route contract, read from native Orca's own catalogs.
 *
 *  Every consumer that decides whether a route may launch — worker-start
 *  admission, reviewer routing, retained re-engagement, the Package B registry,
 *  and any launcher policy outside this repo — must read capability from HERE
 *  rather than keep its own agent/model list. A hand-maintained allowlist that
 *  disagrees with the catalog is drift, and drift is what this module makes
 *  visible instead of letting it read as "the provider cannot do it".
 *
 *  The one legitimate hand-maintained fact is `supportsWorkerLaunchPreferences`:
 *  an explicit opt-in for running an agent's launch overrides unattended. Its
 *  ABSENCE is reported as typed policy drift, never as provider incapability,
 *  because the catalog already proves the capability exists.
 */

export type NativeRouteVerdict =
  /** Native Orca can launch this exact route today. */
  | 'NATIVE_ROUTE_SUPPORTED'
  /** The catalog can pin this model at launch, but the agent is not opted into
   *  unattended worker launch. A policy gap, not a provider limit. */
  | 'BLOCKED_SAFE_LAUNCH_POLICY_DRIFT'
  /** Launchable, but the requested id is a family alias or absent from the seed,
   *  so the EFFECTIVE identity cannot be proven without a provider probe. */
  | 'IDENTITY_PROOF_INCOMPLETE'
  /** Native Orca genuinely has no route: no catalog, or no way to apply a model. */
  | 'TRULY_UNSUPPORTED'

export type NativeRouteCapability = {
  agent: TuiAgent
  /** Orca has a launch configuration for this agent at all. */
  launcherSupported: boolean
  /** Orca installs its managed agent hooks into this agent's CLI. */
  hookSupported: boolean
  /** Excluded from Orca worker routing by explicit policy, whatever else holds. */
  excludedFromWorkerRouting: boolean
  hasCatalog: boolean
  /** Seeded model ids. A seed, not a closed set — see `discoversExactModels`. */
  models: readonly string[]
  /** The catalog knows how to put a model on the launch command line. */
  canApplyModelAtLaunch: boolean
  /** Explicitly opted into unattended per-worker launch overrides. */
  optedIntoWorkerLaunch: boolean
  /** Reasoning/effort values the catalog advertises for the requested model. */
  effortChoices: readonly string[]
  /** The catalog can ask the installed CLI for exact per-host model names. */
  discoversExactModels: boolean
  /** Opaque ids may launch with these options rather than being rejected. */
  acceptsUnknownModelIds: boolean
}

/** Why these live here too: a consumer asking "may this route launch?" needs the
 *  launcher, hook and exclusion facts in the SAME answer as the model facts.
 *  Splitting them is what pushes every caller into assembling its own table. */
const EXCLUDED_FROM_WORKER_ROUTING: readonly TuiAgent[] = ['qwen-code']

function orchestrationFacts(agent: TuiAgent): {
  launcherSupported: boolean
  hookSupported: boolean
  excludedFromWorkerRouting: boolean
} {
  return {
    launcherSupported: Boolean(TUI_AGENT_CONFIG[agent]),
    hookSupported: (AGENT_HOOK_TARGETS as readonly string[]).includes(agent),
    excludedFromWorkerRouting: EXCLUDED_FROM_WORKER_ROUTING.includes(agent)
  }
}

function effortChoicesFor(
  catalog: AgentSessionOptionCatalog,
  model: string | null
): readonly string[] {
  const options = model
    ? (findCatalogModel(catalog, model)?.options ?? catalog.unknownModelOptions ?? [])
    : (catalog.models[0]?.options ?? [])
  const effort = options.find((option) => option.category === 'thought_level')
  return effort?.kind.type === 'select'
    ? effort.kind.choices.map((choice) => String(choice.value))
    : []
}

export function resolveNativeRouteCapability(
  agent: TuiAgent,
  model: string | null = null
): NativeRouteCapability {
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog) {
    return {
      agent,
      ...orchestrationFacts(agent),
      hasCatalog: false,
      models: [],
      canApplyModelAtLaunch: false,
      optedIntoWorkerLaunch: false,
      effortChoices: [],
      discoversExactModels: false,
      acceptsUnknownModelIds: false
    }
  }
  return {
    agent,
    ...orchestrationFacts(agent),
    hasCatalog: true,
    models: catalog.models.map((entry) => entry.id),
    canApplyModelAtLaunch: Boolean(catalog.modelApply.launchArgs),
    optedIntoWorkerLaunch: catalog.supportsWorkerLaunchPreferences === true,
    effortChoices: effortChoicesFor(catalog, model),
    discoversExactModels: Boolean(catalog.listModels),
    acceptsUnknownModelIds: (catalog.unknownModelOptions ?? []).length > 0
  }
}

export type NativeRouteClassification = {
  verdict: NativeRouteVerdict
  capability: NativeRouteCapability
  reason: string
}

/** The typed answer to "can native Orca launch this exact route right now?".
 *  Callers must branch on the verdict rather than re-deriving their own rule. */
export function classifyNativeRoute(args: {
  agent: TuiAgent
  model?: string | null
  reasoning?: string | null
}): NativeRouteClassification {
  const model = args.model ?? null
  const capability = resolveNativeRouteCapability(args.agent, model)
  if (capability.excludedFromWorkerRouting) {
    return {
      verdict: 'TRULY_UNSUPPORTED',
      capability,
      reason: `${args.agent} is excluded from Orca worker routing by explicit policy.`
    }
  }
  if (!capability.hasCatalog || !capability.canApplyModelAtLaunch) {
    return {
      verdict: 'TRULY_UNSUPPORTED',
      capability,
      reason: `Native Orca has no way to apply a model to ${args.agent} at launch.`
    }
  }
  if (!capability.optedIntoWorkerLaunch) {
    return {
      verdict: 'BLOCKED_SAFE_LAUNCH_POLICY_DRIFT',
      capability,
      reason: `${args.agent} can pin a model at launch (${capability.models.join(', ')}), but is not opted into unattended worker launch. This is Orca launch policy, not a provider limit.`
    }
  }
  if (args.reasoning && !capability.effortChoices.includes(args.reasoning)) {
    return {
      verdict: 'TRULY_UNSUPPORTED',
      capability,
      reason: `${args.agent} does not advertise reasoning ${args.reasoning}${
        capability.effortChoices.length > 0 ? ` (has ${capability.effortChoices.join(', ')})` : ''
      }.`
    }
  }
  if (model && !capability.models.includes(model)) {
    return {
      verdict:
        capability.discoversExactModels || capability.acceptsUnknownModelIds
          ? 'IDENTITY_PROOF_INCOMPLETE'
          : 'TRULY_UNSUPPORTED',
      capability,
      reason: `${model} is not in ${args.agent}'s seeded catalog; ${
        capability.discoversExactModels
          ? 'a host probe can still discover it, so identity is unproven rather than impossible.'
          : capability.acceptsUnknownModelIds
            ? 'the catalog accepts opaque ids, so identity is unproven rather than impossible.'
            : 'and the catalog cannot discover it.'
      }`
    }
  }
  return {
    verdict: 'NATIVE_ROUTE_SUPPORTED',
    capability,
    reason: `Native Orca launches ${args.agent}${model ? ` with ${model}` : ''} today.`
  }
}
