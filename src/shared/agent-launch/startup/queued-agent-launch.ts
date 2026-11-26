import { isTuiAgent, TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import { stockLaunchProgram, stockProgramKey } from './managed-agent-launch-program'
import { isFreshOmpLaunchCommand } from './omp-fresh-launch'
import { readLaunchPosition } from './launch-position'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shell/command-resolution/command-token-scanner'

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

const stockPrograms = new Set(
  Object.keys(TUI_AGENT_CONFIG)
    .filter(isTuiAgent)
    .flatMap((agent) => [
      stockLaunchProgram(agent, 'linux'),
      stockLaunchProgram(agent, 'linux', true),
      stockProgramKey(stockLaunchProgram(agent, 'win32'), 'win32'),
      stockLaunchProgram(agent, 'darwin')
    ])
)

export function mayResolveQueuedAgentLaunch(
  command: string,
  shell: AgentStartupShell,
  platform: NodeJS.Platform
): boolean {
  if (isFreshOmpLaunchCommand(command)) {
    return true
  }
  const executable = readLaunchPosition(command, shell)?.executable
  const program = executable && stockProgramKey(executable, platform)
  return (
    program !== 'claude' &&
    (command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS).includes('ORCA_CLAUDE_INJECTED_CONFIG_DIR') ||
      Boolean(program && (stockPrograms.has(program) || /[\\/]agent-runtimes[\\/]/i.test(program))))
  )
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
