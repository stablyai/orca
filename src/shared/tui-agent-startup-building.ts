import {
  ORCA_OMP_FORCE_NEW_SESSION_ENV,
  ORCA_OMP_FRESH_SESSION_DIR_ENV
} from './omp-fresh-session-env'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

export function buildStartupEnv(
  agent: TuiAgent,
  agentEnv: Record<string, string> | null | undefined
): Record<string, string> | undefined {
  if (agent !== 'omp') {
    return agentEnv ? { ...agentEnv } : undefined
  }
  return { ...agentEnv, [ORCA_OMP_FORCE_NEW_SESSION_ENV]: '1' }
}

function shellEnvArg(name: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') {
    return `"${'${'}env:${name}}"`
  }
  if (shell === 'cmd') {
    return `"%${name}%"`
  }
  return `"$${name}"`
}

function commandHasOmpSessionSelector(command: string): boolean {
  return /(^|\s)(?:--session-dir(?:=|\s)|--resume(?:=|\s|$)|-r(?:\s|$)|--continue(?:\s|$)|-c(?:\s|$)|--no-session(?:\s|$)|--fork(?:=|\s|$))/.test(
    command
  )
}

export function withFreshOmpSessionDir(args: {
  agent: TuiAgent
  command: string
  shell: AgentStartupShell
  isRemote?: boolean
}): string {
  if (args.agent !== 'omp' || args.isRemote || commandHasOmpSessionSelector(args.command)) {
    return args.command
  }
  return `${args.command} --session-dir ${shellEnvArg(ORCA_OMP_FRESH_SESSION_DIR_ENV, args.shell)}`
}
