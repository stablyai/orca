/**
 * The account routing a desktop prepared for a terminal agent on a host with no account services
 * of its own (a WSL distro's orcad): which Claude/Codex home the agent's process starts with.
 *
 * Deliberately narrow. Only the four routing variables, only absolute POSIX paths (the pointer may
 * be `~/`-relative, as the `claude` shell function expands it), and never read for a structured
 * session, whose home stays host-derived.
 */

import { z } from 'zod'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV
} from './claude-profile-routing'

export const AGENT_LAUNCH_ACCOUNT_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  'CODEX_HOME'
] as const

export type AgentLaunchAccountEnvKey = (typeof AGENT_LAUNCH_ACCOUNT_ENV_KEYS)[number]

const MAX_ACCOUNT_PATH_LENGTH = 4096

function isAccountEnvKey(key: string): key is AgentLaunchAccountEnvKey {
  return AGENT_LAUNCH_ACCOUNT_ENV_KEYS.some((allowed) => allowed === key)
}

function isAccountPath(key: AgentLaunchAccountEnvKey, value: string): boolean {
  if (value.length === 0 || value.length > MAX_ACCOUNT_PATH_LENGTH || /[\0\r\n]/.test(value)) {
    return false
  }
  const relative = key === CLAUDE_PROFILE_POINTER_ENV && value.startsWith('~/')
  if (!relative && !value.startsWith('/')) {
    return false
  }
  return !value.split('/').includes('..')
}

/** Why a refusal, not a drop: a dropped home would start the agent under another account. */
export const AgentLaunchAccountEnv = z.record(z.string(), z.string()).superRefine((env, ctx) => {
  for (const [key, value] of Object.entries(env)) {
    if (!isAccountEnvKey(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Not an account variable' })
    } else if (!isAccountPath(key, value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Invalid account path' })
    }
  }
  const injected = env[CLAUDE_INJECTED_CONFIG_DIR_ENV]
  if (injected !== undefined && injected !== env.CLAUDE_CONFIG_DIR) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [CLAUDE_INJECTED_CONFIG_DIR_ENV],
      message: 'Must name the injected CLAUDE_CONFIG_DIR'
    })
  }
})

export const STRUCTURED_ACCOUNT_ENV_IGNORED_WARNING =
  'Account selection is not supported for this session type on WSL hosts yet; the chat uses the host default account.'
