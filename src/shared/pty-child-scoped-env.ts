import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from './setup-agent-sequencing'

const PTY_CHILD_SCOPED_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
] as const

export function removeUnspecifiedPtyChildScopedEnv(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined
): void {
  for (const key of PTY_CHILD_SCOPED_ENV_KEYS) {
    if (!explicitEnv || !Object.hasOwn(explicitEnv, key)) {
      delete env[key]
    }
  }
}
