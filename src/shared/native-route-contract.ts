import { findCatalogModel, getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { hasAgentHookIngestion } from './agent-hook-types'
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

/** How native Orca can actually put this agent on screen.
 *
 *  Why two: modelling only the structured path made agents that Orca launches
 *  perfectly well through a custom terminal read as "no native route". Both are
 *  native launches; they differ in whether Orca composes the command line from
 *  its catalog or the caller supplies it and Orca supervises the result. */
export type NativeLaunchStrategy =
  /** `worker-start --model/--effort`: Orca composes the launch from its catalog. */
  | 'worker_start_preferences'
  /** A custom terminal command Orca then supervises and hooks. */
  | 'custom_terminal_attach'

export type NativeRouteCapability = {
  agent: TuiAgent
  /** Orca has a launch configuration for this agent at all. */
  launcherSupported: boolean
  /** Orca can receive hook events for this agent, by managed script OR by the
   *  agent's own plugin. Not the same as "Orca installs scripts into it". */
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
  /** Every way native Orca can launch this agent today. */
  launchStrategies: readonly NativeLaunchStrategy[]
  /** True when ANY strategy can launch it. A verdict short of
   *  NATIVE_ROUTE_SUPPORTED never means Orca cannot launch the agent. */
  nativeLaunchPossible: boolean
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
    hookSupported: hasAgentHookIngestion(agent),
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
      acceptsUnknownModelIds: false,
      ...launchStrategiesFor(agent, false)
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
    acceptsUnknownModelIds: (catalog.unknownModelOptions ?? []).length > 0,
    ...launchStrategiesFor(agent, catalog.supportsWorkerLaunchPreferences === true)
  }
}

/** Orca can supervise a custom terminal for any agent it has a launch config
 *  for, so that strategy is available whenever the launcher is. The structured
 *  strategy additionally needs the unattended-launch opt-in. */
function launchStrategiesFor(
  agent: TuiAgent,
  optedIntoWorkerLaunch: boolean
): { launchStrategies: readonly NativeLaunchStrategy[]; nativeLaunchPossible: boolean } {
  const facts = orchestrationFacts(agent)
  if (!facts.launcherSupported || facts.excludedFromWorkerRouting) {
    return { launchStrategies: [], nativeLaunchPossible: false }
  }
  const strategies: NativeLaunchStrategy[] = ['custom_terminal_attach']
  if (optedIntoWorkerLaunch) {
    strategies.unshift('worker_start_preferences')
  }
  return { launchStrategies: strategies, nativeLaunchPossible: true }
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
  if (!capability.launcherSupported) {
    return {
      verdict: 'TRULY_UNSUPPORTED',
      capability,
      reason: `Native Orca has no launch configuration for ${args.agent}.`
    }
  }
  if (!capability.hasCatalog || !capability.canApplyModelAtLaunch) {
    // Why not TRULY_UNSUPPORTED: Orca launches this agent, and may resume and
    // observe it. What it cannot do is PIN and verify a model through its own
    // structured catalog, which makes the effective identity unprovable — a
    // weaker statement than "there is no route".
    return {
      verdict: 'IDENTITY_PROOF_INCOMPLETE',
      capability,
      reason: `Native Orca launches ${args.agent} through a supervised custom terminal, but has no session-option catalog for it, so Orca cannot compose or verify the model itself.`
    }
  }
  if (!capability.optedIntoWorkerLaunch) {
    return {
      verdict: 'BLOCKED_SAFE_LAUNCH_POLICY_DRIFT',
      capability,
      reason: `${args.agent} can pin a model at launch (${capability.models.join(', ')}) and Orca CAN launch it through a supervised custom terminal; it is only the structured worker-start path that is not opted in. Orca launch policy, not a provider limit.`
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
