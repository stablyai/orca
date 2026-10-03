import type { GlobalSettings } from './global-settings-types'
import { isTuiAgent } from './tui-agent-config'
import { YOLO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'
import {
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'

const UNSUPPORTED_TUI_AGENT_ARGS: Partial<Record<TuiAgent, readonly string[]>> = {
  opencode: ['--dangerously-skip-permissions'],
  kilo: ['--dangerously-skip-permissions']
}

export const DEFAULT_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = YOLO_TUI_AGENT_ARGS

// Why: privacy-sensitive defaults that are not permission/YOLO modes. Grok Build
// can upload session traces when trace_upload is on; Orca-launched Grok sessions
// opt out by default (users can override via Settings → agent default env).
// See open-source xai-org/grok-build telemetry config + GROK_TELEMETRY_TRACE_UPLOAD.
const GROK_LAUNCH_PRIVACY_ENV: Record<string, string> = {
  GROK_TELEMETRY_TRACE_UPLOAD: '0'
}

export const DEFAULT_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  ...YOLO_TUI_AGENT_ENV,
  grok: { ...GROK_LAUNCH_PRIVACY_ENV }
}

function argPattern(arg: string): RegExp {
  return new RegExp(`(^|\\s)${arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g')
}

export function hasUnsupportedTuiAgentArgs(agent: TuiAgent, value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  return (UNSUPPORTED_TUI_AGENT_ARGS[agent] ?? []).some((arg) => argPattern(arg).test(value))
}

/**
 * Whether the configured arguments carry this agent's permission-bypass flag.
 *
 * The Agent Permissions toggle has no storage of its own — it writes and reads this flag inside
 * the arguments string. Read the same argv the startup path builds so quoted prompt text and
 * operands after `--` cannot authorize a structured session.
 */
export function tuiAgentArgsBypassPermissions(
  agent: TuiAgent,
  value: string | null | undefined,
  shell: AgentStartupShell
): boolean {
  const bypassArg = YOLO_TUI_AGENT_ARGS[agent]
  if (typeof value !== 'string' || bypassArg === undefined) {
    return false
  }
  const tokenized = tokenizeStartupCommand(value, shell)
  if (!tokenized.ok) {
    return false
  }
  const terminator = tokenized.tokens.indexOf('--')
  const options = terminator === -1 ? tokenized.tokens : tokenized.tokens.slice(0, terminator)
  return options.includes(bypassArg)
}

function sanitizeTuiAgentLaunchArgs(agent: TuiAgent, args: string): string {
  const unsupportedArgs = UNSUPPORTED_TUI_AGENT_ARGS[agent]
  if (!unsupportedArgs) {
    return args.trim()
  }
  // Why: a few agents have removed, relocated, or never exposed Claude-style
  // skip-permission flags on the interactive TUI command Orca launches.
  return unsupportedArgs.reduce((next, arg) => next.replace(argPattern(arg), ' '), args).trim()
}

export function normalizeTuiAgentArgsRecord(value: unknown): Partial<Record<TuiAgent, string>> {
  const normalized: Partial<Record<TuiAgent, string>> = {}
  if (!value || typeof value !== 'object') {
    return normalized
  }
  for (const [agent, args] of Object.entries(value)) {
    if (!isTuiAgent(agent) || typeof args !== 'string') {
      continue
    }
    normalized[agent] = sanitizeTuiAgentLaunchArgs(agent, args)
  }
  return normalized
}

export function normalizeTuiAgentEnvRecord(
  value: unknown
): Partial<Record<TuiAgent, Record<string, string>>> {
  const normalized: Partial<Record<TuiAgent, Record<string, string>>> = {}
  if (!value || typeof value !== 'object') {
    return normalized
  }
  for (const [agent, env] of Object.entries(value)) {
    if (!isTuiAgent(agent) || !env || typeof env !== 'object') {
      continue
    }
    const nextEnv: Record<string, string> = {}
    for (const [name, raw] of Object.entries(env)) {
      const key = name.trim()
      if (!key || typeof raw !== 'string') {
        continue
      }
      nextEnv[key] = raw
    }
    normalized[agent] = nextEnv
  }
  return normalized
}

export function getTuiAgentDefaultArgs(agent: TuiAgent): string {
  return DEFAULT_TUI_AGENT_ARGS[agent] ?? ''
}

export function getTuiAgentDefaultEnv(agent: TuiAgent): Record<string, string> {
  return { ...DEFAULT_TUI_AGENT_ENV[agent] }
}

export function resolveTuiAgentLaunchArgs(
  agent: TuiAgent,
  configuredArgs: Partial<Record<TuiAgent, string>> | null | undefined
): string {
  if (
    configuredArgs &&
    Object.hasOwn(configuredArgs, agent) &&
    typeof configuredArgs[agent] === 'string'
  ) {
    return configuredArgs[agent] ?? ''
  }
  return getTuiAgentDefaultArgs(agent)
}

/**
 * Whether this agent's *resolved* launch arguments ask for a permission bypass.
 *
 * Resolved, not configured: an untouched Arguments field falls back to the default Orca ships,
 * which is the bypass flag, so bypass is the posture a user gets until they choose otherwise.
 * Choosing Manual stores an empty string, which owns the key and so beats that default.
 */
export function resolvedTuiAgentArgsBypassPermissions(
  agent: TuiAgent,
  settings:
    | Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'terminalWindowsShell'>>
    | null
    | undefined,
  platform: NodeJS.Platform
): boolean {
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings?.terminalWindowsShell
    })
  )
  return tuiAgentArgsBypassPermissions(
    agent,
    resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
    shell
  )
}

export function resolveTuiAgentLaunchEnv(
  agent: TuiAgent,
  configuredEnv: Partial<Record<TuiAgent, Record<string, string>>> | null | undefined
): Record<string, string> {
  if (configuredEnv && Object.hasOwn(configuredEnv, agent)) {
    return { ...configuredEnv[agent] }
  }
  return getTuiAgentDefaultEnv(agent)
}
