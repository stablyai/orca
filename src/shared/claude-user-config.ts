import { join, resolve } from 'node:path'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from './claude-profile-routing'

/** The user's own CLAUDE_CONFIG_DIR (their System default), or undefined for `~/.claude`. */
export function readUserClaudeConfigDir(env: NodeJS.ProcessEnv): string | undefined {
  const user = readUserClaudeConfigDirAsSet(env)
  return user === undefined ? undefined : resolve(user.trim())
}

/**
 * The user's own CLAUDE_CONFIG_DIR exactly as they set it. Why unresolved: Claude keys its login by
 * the literal string, and the shell compares it against what an rc file re-exports.
 */
export function readUserClaudeConfigDirAsSet(env: NodeJS.ProcessEnv): string | undefined {
  const configDir = env.CLAUDE_CONFIG_DIR
  const injected = env[CLAUDE_INJECTED_CONFIG_DIR_ENV]?.trim()
  if (!configDir?.trim()) {
    return undefined
  }
  if (injected && resolve(injected) === resolve(configDir.trim())) {
    return env[CLAUDE_USER_CONFIG_DIR_ENV]?.trim() ? env[CLAUDE_USER_CONFIG_DIR_ENV] : undefined
  }
  return configDir
}

/** The folder profiles share from: the user's own CLAUDE_CONFIG_DIR, else `~/.claude`. */
export function resolveClaudeDefaultHome(userHome: string, userConfigDir?: string): string {
  return userConfigDir ?? join(userHome, '.claude')
}
