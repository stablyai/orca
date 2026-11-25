// Each app profile has its own `~/.orca` and agent folders.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyAppProfileHomesCore } from './app-profile-env-core'

/**
 * Overrides `~/.orca`. Only an app profile sets it. Every Orca entry point (the main bundle's
 * banner, orcad, the CLI) sets it for a profile and removes it otherwise, so a value under it is
 * a profile's value.
 */
export const ORCA_HOME_DIR_ENV = 'ORCA_HOME_DIR'

/**
 * Agent CLIs that read their folder from a variable (checked in each CLI's docs or source), and the
 * profile's subfolder for each. Agents without such a variable, and Pi, OMP, Prime Agent and
 * OpenCode (Orca rewrites their variables per pane, or they move only with XDG), read the real
 * home: the isAppProfileRuntime() checks guard them.
 */
export const APP_PROFILE_AGENT_HOME_VARIABLES = {
  CLAUDE_CONFIG_DIR: 'claude',
  CODEX_HOME: 'codex',
  GROK_HOME: 'grok',
  COPILOT_HOME: 'copilot',
  HERMES_HOME: 'hermes',
  KIMI_CODE_HOME: 'kimi-code',
  KIRO_HOME: 'kiro',
  OPENCLAW_STATE_DIR: 'openclaw',
  MIMOCODE_HOME: 'mimocode',
  QWEN_HOME: 'qwen',
  QODER_CONFIG_DIR: 'qoder',
  CODEBUDDY_CONFIG_DIR: 'codebuddy',
  CLINE_DIR: 'cline'
} as const

export type AppProfileAgentHomeVariable = keyof typeof APP_PROFILE_AGENT_HOME_VARIABLES

/** The variables that a profile sets: `~/.orca` and the agent folders. */
export const APP_PROFILE_HOME_ENV_KEYS: readonly string[] = [
  ORCA_HOME_DIR_ENV,
  ...Object.keys(APP_PROFILE_AGENT_HOME_VARIABLES)
]

/**
 * Points `~/.orca` and the agent folders at the profile, or with null removes the values that a
 * profile set. A profile replaces a value that the user set; the default app keeps it. Children
 * (terminals, serve, orcad, agents) inherit the result. Shell startup files that export these variables override them in a terminal.
 */
export function applyAppProfileHomes(userDataPath: string | null, env: NodeJS.ProcessEnv): void {
  applyAppProfileHomesCore(env, userDataPath, APP_PROFILE_AGENT_HOME_VARIABLES)
}

/** Whether a value lies under the profile's `ORCA_HOME_DIR`, that is, a profile set it. */
export function isAppProfileHomeValue(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): value is string {
  const profileHome = env[ORCA_HOME_DIR_ENV]
  return Boolean(
    profileHome && value && (value === profileHome || value.startsWith(`${profileHome}/`))
  )
}

function isLocalHome(home: string): boolean {
  return resolve(home) === resolve(homedir())
}

/** `~/.orca` of this machine's user, or the profile's. Another home (a remote host) keeps its own. */
export function orcaHomeDir(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env[ORCA_HOME_DIR_ENV]?.trim()
  return override && isLocalHome(home) ? override : join(home, '.orca')
}

/** An agent's folder that a profile set; else the folder in the user's home. */
export function defaultAgentHomeDir(
  variable: AppProfileAgentHomeVariable,
  homeRelative: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const value = env[variable]?.trim()
  return isAppProfileHomeValue(value, env) ? value : join(homedir(), homeRelative)
}

/** An agent's folder in `home`: the profile's when `home` is this user's home, else `home`'s own. */
export function agentHomeDirIn(
  home: string,
  variable: AppProfileAgentHomeVariable,
  homeRelative: string,
  joinPath: (...segments: string[]) => string = join
): string {
  return isLocalHome(home)
    ? defaultAgentHomeDir(variable, homeRelative)
    : joinPath(home, homeRelative)
}

/** Claude's global state file: in CLAUDE_CONFIG_DIR when a profile set it, else `~/.claude.json`. */
export function defaultClaudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  return isAppProfileHomeValue(dir, env)
    ? join(dir, '.claude.json')
    : join(homedir(), '.claude.json')
}
