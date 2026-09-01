// Client-safe agent-launch contracts: typed notices, launch-attempt failures,
// request/control-plane errors, and the launch receipt. These may cross RPC to
// mobile/paired clients. They never carry env keys/values, full argv, paths,
// prompts, or labels beyond the requested agent's display label in notices.
// Host-only resolution/request types live in agent-launch-host-contract.ts.

import type { BuiltInTuiAgent, TuiAgent } from './types'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import type { AgentKind } from './telemetry-events'

/** Serializable intent kind persisted in records; the richer LaunchIntent union
 *  is host-only and never an RPC parameter. */
export type AgentLaunchIntentKind =
  | 'interactive'
  | 'cli'
  | 'automation'
  | 'background'
  | 'orchestration'
  | 'resume'

export type AgentLaunchNotice =
  // baseAgent fills the {base} placeholder in fallback copy; label is the
  // requested agent's display label.
  | { code: 'missing_custom_fallback'; label: string; baseAgent: BuiltInTuiAgent }
  | { code: 'disabled_custom_fallback'; label: string; baseAgent: BuiltInTuiAgent }
  | { code: 'snapshot_definition_changed'; label: string }
  | { code: 'env_withheld'; label: string }
  | { code: 'vault_original_config_unavailable'; baseAgent: BuiltInTuiAgent }

export type AgentLaunchNoticeCode = AgentLaunchNotice['code']

/** Host-owned per-terminal launch-notice state persisted with terminal/session
 *  metadata. The host is the sole owner: renderer/mobile stores mirror it and
 *  never independently recreate a dismissed notice. `launchToken` scopes
 *  dismissal to this terminal and is never logged or sent to telemetry. */
export type PersistedLaunchNoticeState = {
  launchToken: string
  notices: readonly AgentLaunchNotice[]
}

export type AgentLaunchFailureCode =
  | 'unknown_agent'
  | 'no_agent_selected'
  | 'agent_definition_needs_repair'
  | 'custom_agent_disabled'
  | 'agent_configuration_changed'
  | 'base_agent_disabled'
  | 'base_agent_unavailable'
  | 'missing_variable'
  | 'missing_target_home'
  | 'invalid_command_override'
  | 'invalid_agent_args'
  | 'invalid_agent_env'
  | 'secure_env_transport_unavailable'
  | 'launch_command_too_long'
  | 'invalid_launch_snapshot'
  | 'trust_preflight_failed'
  | 'spawn_failed'
  | 'launch_state_unknown'
  | 'launch_capacity_exceeded'

export type AgentLaunchFailureFieldHint =
  | 'identity'
  | 'baseAgent'
  | 'label'
  | 'commandOverride'
  | 'args'
  | 'env'

export type AgentLaunchFailureReasonHint =
  | 'unterminated_quote'
  | 'quoted_line_break'
  | 'cmd_metachar'
  | 'control_char'
  | 'empty'
  | 'bounds'
  | 'reserved_name'
  | 'prototype_key'
  | 'case_collision'
  | 'duplicate_id'
  | 'identity_mismatch'
  | 'environment_block_too_large'
  | 'arg_env_too_large'
  | 'shell_operator'
  | 'tilde_user'
  | 'capacity'

export type AgentLaunchFailure = {
  code: AgentLaunchFailureCode
  requestedAgent?: TuiAgent
  baseAgent?: BuiltInTuiAgent
  variable?: 'repoPath' | 'worktreePath'
  // Client-safe repair hints only. Never carry values, full argv, paths,
  // labels, env keys, or env values.
  field?: AgentLaunchFailureFieldHint
  shell?: AgentStartupShell
  reason?: AgentLaunchFailureReasonHint
}

/** Request/control-plane rejections do not describe a launch attempt and are
 *  never persisted over an owner's existing failure or pending state. */
export type AgentLaunchRequestError = {
  code: 'idempotency_conflict' | 'stale_agent_launch_failure' | 'untrusted_reference'
}

export type PersistedAgentLaunchFailure = AgentLaunchFailure & {
  version: 1
  failureId: string
  intent: AgentLaunchIntentKind
  occurredAt: number
}

export type AgentLaunchReceipt = {
  requestedAgent: TuiAgent
  baseAgent: BuiltInTuiAgent
  notices: readonly AgentLaunchNotice[]
  launchToken: string
  catalogRevision: number
  // Host-derived agent_started attribution: the base kind and whether a custom
  // agent launched (snapshot mode === 'custom'). Client-safe (closed enum +
  // boolean) — never a requested id/label. The single authority the emitters and
  // the host create-emit read so client-supplied agent_kind stays vestigial.
  telemetry: { agentKind: AgentKind; usedCustomAgent: boolean }
}
