import * as z from 'zod'
import {
  MAX_AGENT_API_KEYS,
  MAX_AGENT_API_KEY_VALUE_LENGTH,
  agentApiKeyEnvNameError,
  agentApiKeyValueError
} from './agent-api-key-catalog'

/** API keys a desktop carries for one agent process. The host merges them into that launch only and never persists them. */
export const AgentKeyLaunchEnv = z
  .record(z.string(), z.string().max(MAX_AGENT_API_KEY_VALUE_LENGTH))
  .superRefine((env, ctx) => {
    const entries = Object.entries(env)
    if (entries.length > MAX_AGENT_API_KEYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Too many key variables' })
    }
    for (const [name, value] of entries) {
      // Never echo the value into the issue: refusals are logged.
      if (agentApiKeyEnvNameError(name) || agentApiKeyValueError(name, value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'Not a usable key' })
      }
    }
  })

export type AgentKeyLaunchEnvValue = z.infer<typeof AgentKeyLaunchEnv>

/** Fold carried keys into the account env a host already merges over its launch plan. */
export function withAgentKeyLaunchEnv(
  accountEnv: Readonly<Record<string, string>> | undefined,
  keyEnv: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  if (!keyEnv || Object.keys(keyEnv).length === 0) {
    return accountEnv ? { ...accountEnv } : undefined
  }
  // Account routing names homes, not keys, so the two never collide; keys go first so routing still wins.
  return { ...keyEnv, ...accountEnv }
}
