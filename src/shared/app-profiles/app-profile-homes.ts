// The paths of `~/.orca` and of the agent folders. Code reads them only through these helpers.
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Agent CLIs that read their folder from a variable (checked in each CLI's docs or source), each
 * with the name of its folder in an app profile (#46496). Agents without such a variable, and Pi,
 * OMP, Prime Agent and OpenCode (Orca rewrites their variables per pane, or they move only with
 * XDG), are not in this list.
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

/** `~/.orca` in `home`. */
export function orcaHomeDir(home: string = homedir()): string {
  return join(home, '.orca')
}

/** An agent's folder in the user's home. `variable` names the agent's folder variable. */
export function defaultAgentHomeDir(
  _variable: AppProfileAgentHomeVariable,
  homeRelative: string
): string {
  return join(homedir(), homeRelative)
}

/** An agent's folder in `home`. `variable` names the agent's folder variable. */
export function agentHomeDirIn(
  home: string,
  _variable: AppProfileAgentHomeVariable,
  homeRelative: string,
  joinPath: (...segments: string[]) => string = join
): string {
  return joinPath(home, homeRelative)
}

/** Claude's global state file, `~/.claude.json`. */
export function defaultClaudeJsonPath(): string {
  return join(homedir(), '.claude.json')
}
