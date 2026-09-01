// Strict runtime validators for the persisted agent-launch failure contract.
// U6 owner records (automation run, orchestration dispatch, generic background
// attempt) round-trip these failures through JSON/SQLite, so normalization must
// fail closed: a control-plane request error must NEVER parse as a launch
// failure, and an unknown or extra field must reject rather than silently
// persist. One enum keeps every failure code, field hint, and reason hint in a
// single place so adding a union member forces updating the schema.

import { z } from 'zod'
import { isBuiltInTuiAgent, isTuiAgent } from './tui-agent-config'
import type {
  AgentLaunchFailure,
  AgentLaunchFailureCode,
  AgentLaunchFailureFieldHint,
  AgentLaunchFailureReasonHint,
  AgentLaunchIntentKind,
  PersistedAgentLaunchFailure
} from './agent-launch-contract'
import type { BuiltInTuiAgent, TuiAgent } from './types'

export const AGENT_LAUNCH_FAILURE_CODES = [
  'unknown_agent',
  'no_agent_selected',
  'agent_definition_needs_repair',
  'custom_agent_disabled',
  'agent_configuration_changed',
  'base_agent_disabled',
  'base_agent_unavailable',
  'missing_variable',
  'missing_target_home',
  'invalid_command_override',
  'invalid_agent_args',
  'invalid_agent_env',
  'secure_env_transport_unavailable',
  'launch_command_too_long',
  'invalid_launch_snapshot',
  'trust_preflight_failed',
  'spawn_failed',
  'launch_state_unknown',
  'launch_capacity_exceeded'
] as const satisfies readonly AgentLaunchFailureCode[]

export const AGENT_LAUNCH_FAILURE_FIELD_HINTS = [
  'identity',
  'baseAgent',
  'label',
  'commandOverride',
  'args',
  'env'
] as const satisfies readonly AgentLaunchFailureFieldHint[]

export const AGENT_LAUNCH_FAILURE_REASON_HINTS = [
  'unterminated_quote',
  'quoted_line_break',
  'cmd_metachar',
  'control_char',
  'empty',
  'bounds',
  'reserved_name',
  'prototype_key',
  'case_collision',
  'duplicate_id',
  'identity_mismatch',
  'environment_block_too_large',
  'arg_env_too_large',
  'shell_operator',
  'tilde_user',
  'capacity'
] as const satisfies readonly AgentLaunchFailureReasonHint[]

export const AGENT_LAUNCH_INTENT_KINDS = [
  'interactive',
  'cli',
  'automation',
  'background',
  'orchestration',
  'resume'
] as const satisfies readonly AgentLaunchIntentKind[]

const tuiAgentSchema = z.custom<TuiAgent>((v) => isTuiAgent(v))
const builtInTuiAgentSchema = z.custom<BuiltInTuiAgent>((v) => isBuiltInTuiAgent(v))

/** Strict client-safe failure body. `.strict()` rejects any extra key so a
 *  request error (`idempotency_conflict`, `stale_agent_launch_failure`,
 *  `untrusted_reference`) — whose shape is `{ code }` with a non-failure code —
 *  cannot masquerade as a launch failure, and a stray argv/env/path field can
 *  never ride through normalization. */
export const agentLaunchFailureSchema = z
  .object({
    code: z.enum(AGENT_LAUNCH_FAILURE_CODES),
    requestedAgent: tuiAgentSchema.optional(),
    baseAgent: builtInTuiAgentSchema.optional(),
    variable: z.enum(['repoPath', 'worktreePath']).optional(),
    field: z.enum(AGENT_LAUNCH_FAILURE_FIELD_HINTS).optional(),
    shell: z.enum(['posix', 'powershell', 'cmd']).optional(),
    reason: z.enum(AGENT_LAUNCH_FAILURE_REASON_HINTS).optional()
  })
  .strict() satisfies z.ZodType<AgentLaunchFailure>

export const persistedAgentLaunchFailureSchema = z
  .object({
    code: z.enum(AGENT_LAUNCH_FAILURE_CODES),
    requestedAgent: tuiAgentSchema.optional(),
    baseAgent: builtInTuiAgentSchema.optional(),
    variable: z.enum(['repoPath', 'worktreePath']).optional(),
    field: z.enum(AGENT_LAUNCH_FAILURE_FIELD_HINTS).optional(),
    shell: z.enum(['posix', 'powershell', 'cmd']).optional(),
    reason: z.enum(AGENT_LAUNCH_FAILURE_REASON_HINTS).optional(),
    version: z.literal(1),
    failureId: z.string().min(1),
    intent: z.enum(AGENT_LAUNCH_INTENT_KINDS),
    occurredAt: z.number()
  })
  .strict() satisfies z.ZodType<PersistedAgentLaunchFailure>

/** Parse a stored value into a persisted launch failure, or null when it is
 *  malformed / carries unknown fields / is actually a request error. Owner
 *  records use this on read so a corrupt or forged entry drops instead of
 *  surfacing as a recovery card. */
export function parsePersistedAgentLaunchFailure(
  value: unknown
): PersistedAgentLaunchFailure | null {
  const parsed = persistedAgentLaunchFailureSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
