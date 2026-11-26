import { isFreshOmpLaunchCommand } from './omp-fresh-launch'
import { readLaunchPosition } from './launch-position'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shell/command-resolution/command-token-scanner'
import { agentSessionSignInCommand } from '../../agent-session/lifecycle/launch/agent-session-setup-commands'

export type QueuedAgentLaunch = {
  /** An app PTY id for desktop IPC, or the serving runtime's terminal handle for RPC. */
  terminal: string
  command: string
  shell: AgentStartupShell
  shellOverride?: string
  cwd?: string
  path?: string | null
  images?: boolean
}

export type PreparedAgentLaunch = { preparedCommand: string | null }

export function mayResolveQueuedAgentLaunch(command: string, shell: AgentStartupShell): boolean {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  if (
    prefix.includes('ORCA_CLAUDE_INJECTED_CONFIG_DIR') &&
    command === agentSessionSignInCommand('claude', { account: 'system', remote: false, shell })
  ) {
    return true
  }
  const executable = isFreshOmpLaunchCommand(command)
    ? prefix
    : readLaunchPosition(command, shell)?.executable
  return /[\\/]agent-runtimes[\\/]/i.test(executable ?? '')
}

/** The launch's PATH seed can be set, deleted, or inherited. The other values stay in the PTY. */
export function queuedLaunchPath(
  env: Record<string, string | undefined> | undefined,
  envToDelete: readonly string[] | undefined,
  platform: NodeJS.Platform
): string | null | undefined {
  const isPath = (key: string): boolean =>
    platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH'
  if (envToDelete?.some(isPath)) {
    return null
  }
  return Object.entries(env ?? {}).findLast(([key]) => isPath(key))?.[1]
}
