import { isTuiAgent } from './tui-agent-config'
import { YOLO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'
import type { TuiAgent } from './tui-agent'
import { sha256 } from './sha256'

const UNSUPPORTED_TUI_AGENT_ARGS: Partial<Record<TuiAgent, readonly string[]>> = {
  opencode: ['--dangerously-skip-permissions'],
  kilo: ['--dangerously-skip-permissions']
}

export const DEFAULT_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = YOLO_TUI_AGENT_ARGS

export const DEFAULT_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> =
  YOLO_TUI_AGENT_ENV

function argPattern(arg: string): RegExp {
  return new RegExp(`(^|\\s)${arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g')
}

export function hasUnsupportedTuiAgentArgs(agent: TuiAgent, value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  return (UNSUPPORTED_TUI_AGENT_ARGS[agent] ?? []).some((arg) => argPattern(arg).test(value))
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

export function resolveTuiAgentLaunchEnv(
  agent: TuiAgent,
  configuredEnv: Partial<Record<TuiAgent, Record<string, string>>> | null | undefined
): Record<string, string> {
  if (configuredEnv && Object.hasOwn(configuredEnv, agent)) {
    return { ...configuredEnv[agent] }
  }
  return getTuiAgentDefaultEnv(agent)
}

const CODEX_AUTOMATION_STATE_ROOT = '~/.orca/tmp/codex-automation'

function normalizeCodexAutomationStateId(runId: string): string {
  const readable = runId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'run'
  const digest = Array.from(sha256(new TextEncoder().encode(runId)).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  return `${readable}-${digest}`
}

export function resolveAutomationAgentArgs(
  agent: TuiAgent,
  configuredArgs: Partial<Record<TuiAgent, string>> | null | undefined,
  codexAutomationStateId?: string
): string {
  const defaultArgs = resolveTuiAgentLaunchArgs(agent, configuredArgs)
  if (agent !== 'codex' || !codexAutomationStateId) {
    return defaultArgs
  }
  const statePath = `${CODEX_AUTOMATION_STATE_ROOT}/${normalizeCodexAutomationStateId(codexAutomationStateId)}`
  return `${defaultArgs} -c sqlite_home='${statePath}'`.trim()
}
