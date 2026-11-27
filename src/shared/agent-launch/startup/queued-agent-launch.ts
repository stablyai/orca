import { isFreshOmpLaunchCommand } from './omp-fresh-launch'
import { readLaunchPosition } from './launch-position'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shell/command-resolution/command-token-scanner'
import type { NativeChatSignInRequest } from '../../agent-session/lifecycle/launch/agent-session-setup-commands'

import type { SleepingAgentLaunchConfig } from '../../agent-session/lifecycle/agent-session-resume'
import type { TuiAgent } from '../catalog/tui-agent'

export type QueuedAgentLaunch = {
  /** An app PTY id for desktop IPC, or the serving runtime's terminal handle for RPC. */
  terminal: string
  command: string
  shell: AgentStartupShell
  shellOverride?: string
  cwd?: string
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  restoring?: boolean
  nativeChatSignIn?: NativeChatSignInRequest
  images?: boolean
}

export type PreparedAgentLaunch = {
  preparedCommand: string | null
  launchConfig?: SleepingAgentLaunchConfig
  blocked?: 'unknown' | 'unavailable'
}

export function mayResolveQueuedAgentLaunch(
  launch: Pick<
    QueuedAgentLaunch,
    'command' | 'shell' | 'launchConfig' | 'restoring' | 'nativeChatSignIn'
  >
): boolean {
  const { command, shell, nativeChatSignIn, restoring, launchConfig } = launch
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  if (
    nativeChatSignIn ||
    launchConfig?.commandProvenance === 'generated' ||
    (restoring && !launchConfig?.commandProvenance)
  ) {
    return true
  }
  if (launchConfig?.commandProvenance) {
    return false
  }
  const executable = isFreshOmpLaunchCommand(command)
    ? prefix
    : readLaunchPosition(command, shell)?.executable
  return /[\\/]agent-runtimes[\\/]/i.test(executable ?? '')
}
