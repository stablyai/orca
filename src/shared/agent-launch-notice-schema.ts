// Runtime validators for the client-safe launch-notice contract. Shared by the
// workspace-session read boundary (persisted notice state) and the dismissal
// RPC/IPC (schema-valid code check). Keeping the code enum in one place is what
// lets dismissal "fail closed" on a non-enum code.

import { z } from 'zod'
import { isBuiltInTuiAgent } from './tui-agent-config'
import type { BuiltInTuiAgent } from './types'
import type {
  AgentLaunchNotice,
  AgentLaunchNoticeCode,
  PersistedLaunchNoticeState
} from './agent-launch-contract'

export const AGENT_LAUNCH_NOTICE_CODES = [
  'missing_custom_fallback',
  'disabled_custom_fallback',
  'snapshot_definition_changed',
  'env_withheld',
  'vault_original_config_unavailable'
] as const satisfies readonly AgentLaunchNoticeCode[]

export const agentLaunchNoticeCodeSchema = z.enum(AGENT_LAUNCH_NOTICE_CODES)

const builtInTuiAgentSchema = z.custom<BuiltInTuiAgent>((v) => isBuiltInTuiAgent(v))

export const agentLaunchNoticeSchema = z.discriminatedUnion('code', [
  z.object({
    code: z.literal('missing_custom_fallback'),
    label: z.string(),
    baseAgent: builtInTuiAgentSchema
  }),
  z.object({
    code: z.literal('disabled_custom_fallback'),
    label: z.string(),
    baseAgent: builtInTuiAgentSchema
  }),
  z.object({ code: z.literal('snapshot_definition_changed'), label: z.string() }),
  z.object({ code: z.literal('env_withheld'), label: z.string() }),
  z.object({
    code: z.literal('vault_original_config_unavailable'),
    baseAgent: builtInTuiAgentSchema
  })
]) satisfies z.ZodType<AgentLaunchNotice>

const compatibleAgentLaunchNoticeSchema = z
  .unknown()
  .transform((value, ctx): AgentLaunchNotice | null => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof value.code === 'string' &&
      !AGENT_LAUNCH_NOTICE_CODES.includes(value.code as AgentLaunchNoticeCode)
    ) {
      return null
    }
    const parsed = agentLaunchNoticeSchema.safeParse(value)
    if (parsed.success) {
      return parsed.data
    }
    ctx.addIssue({ code: 'custom', message: 'Invalid agent launch notice' })
    return z.NEVER
  })

export const persistedLaunchNoticeStateSchema = z.object({
  launchToken: z.string().min(1),
  // Why: additive notice codes must not make an older client discard the
  // terminal carrier; unsupported entries are dropped independently.
  notices: z
    .array(compatibleAgentLaunchNoticeSchema)
    .transform((notices) =>
      notices.filter((notice): notice is AgentLaunchNotice => notice !== null)
    )
}) satisfies z.ZodType<PersistedLaunchNoticeState>
