// Resolves a durable post-create agent-launch failure (WorktreeMeta.agentLaunchFailure)
// into the recovery card's action model, following the plan's recovery-card table.
// Pure and presentation-free so it can be unit-tested across every failure code.
//
// Liveness dominates the failure code: while a token-matched terminal may still be
// live we must never offer Retry/Choose agent (that would create the duplicate the
// reconciler exists to prevent), so an unknown/live launch replaces those with
// Reconnect + Forget or Open terminal instead of a code-specific row.

import type {
  AgentLaunchFailure,
  AgentLaunchFailureCode
} from '../../../shared/agent-launch-contract'

export type AgentLaunchRecoveryActionId =
  | 'retry'
  | 'retry-current-settings'
  | 'launch-current-settings'
  | 'choose-agent'
  | 'edit-agent-settings'
  | 'repair-on-host'
  | 'reconnect-securely'
  | 'reconnect'
  | 'recover-capacity'
  | 'open-terminal'
  | 'forget-launch'
  | 'manage-agents'

/** Whether a token-matched terminal for this launch may still be alive. Derived
 *  host-side from provider reconciliation; the failure code alone cannot express
 *  it. `idle` means no live/unknown terminal contends with a fresh attempt. */
export type AgentLaunchRecoveryLiveness = 'idle' | 'unknown' | 'live-unattributed'

export type AgentLaunchRecoveryCardModel = {
  /** The primary recovery affordance for this state. */
  primary: AgentLaunchRecoveryActionId
  /** Additional affordances, in display order. Never includes `primary`. */
  secondary: AgentLaunchRecoveryActionId[]
}

/** The definition-repair codes whose fix is a Settings edit on the agent itself. */
const DEFINITION_REPAIR_CODES: ReadonlySet<AgentLaunchFailureCode> = new Set([
  'invalid_command_override',
  'invalid_agent_args',
  'invalid_agent_env',
  'missing_variable',
  'missing_target_home',
  'launch_command_too_long'
])

/** Codes where the selected agent/base is unavailable and only a different
 *  selection (or a settings change that flips the gate) can recover. */
const SELECTION_UNAVAILABLE_CODES: ReadonlySet<AgentLaunchFailureCode> = new Set([
  'unknown_agent',
  'no_agent_selected',
  'custom_agent_disabled',
  'base_agent_disabled'
])

/** Host/provider-transient codes where an unchanged Retry is the honest path. */
const TRANSIENT_CODES: ReadonlySet<AgentLaunchFailureCode> = new Set([
  'base_agent_unavailable',
  'trust_preflight_failed',
  'spawn_failed'
])

function cardForCode(code: AgentLaunchFailureCode): AgentLaunchRecoveryCardModel {
  if (code === 'launch_state_unknown') {
    return { primary: 'reconnect', secondary: ['forget-launch'] }
  }
  if (SELECTION_UNAVAILABLE_CODES.has(code)) {
    return { primary: 'choose-agent', secondary: ['manage-agents'] }
  }
  if (code === 'agent_definition_needs_repair') {
    // Never safe-fallback or expose the raw corrupt fields; repair happens on the
    // desktop host where the full definition lives.
    return { primary: 'repair-on-host', secondary: ['choose-agent'] }
  }
  if (DEFINITION_REPAIR_CODES.has(code)) {
    return { primary: 'edit-agent-settings', secondary: ['retry', 'choose-agent'] }
  }
  if (code === 'secure_env_transport_unavailable') {
    return { primary: 'reconnect-securely', secondary: ['choose-agent'] }
  }
  if (code === 'agent_configuration_changed') {
    // Retry is an explicit adoption of the now-current configuration.
    return { primary: 'retry-current-settings', secondary: ['choose-agent'] }
  }
  if (code === 'invalid_launch_snapshot') {
    // Never labelled a plain "Retry": the saved launch details are gone, so this
    // launches with the current settings instead of replaying the snapshot.
    return { primary: 'launch-current-settings', secondary: ['choose-agent'] }
  }
  if (code === 'launch_capacity_exceeded') {
    return { primary: 'recover-capacity', secondary: ['choose-agent'] }
  }
  if (TRANSIENT_CODES.has(code)) {
    return { primary: 'retry', secondary: ['choose-agent'] }
  }
  // Exhaustive fallback for any code not otherwise handled keeps the card usable.
  return { primary: 'choose-agent', secondary: ['manage-agents'] }
}

/** Resolve the recovery-card action model for a durable failure. Liveness gates
 *  the code-based row: a live-but-unattributed terminal offers only Open terminal,
 *  and an unknown launch offers Reconnect + Forget, because retrying or choosing a
 *  different agent while a matched terminal may be live risks a duplicate launch. */
export function resolveAgentLaunchRecoveryCard(
  failure: AgentLaunchFailure,
  opts: { liveness: AgentLaunchRecoveryLiveness }
): AgentLaunchRecoveryCardModel {
  if (opts.liveness === 'live-unattributed') {
    return { primary: 'open-terminal', secondary: [] }
  }
  if (opts.liveness === 'unknown') {
    return { primary: 'reconnect', secondary: ['forget-launch'] }
  }
  return cardForCode(failure.code)
}
