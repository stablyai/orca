import { isBuiltInTuiAgent, isTuiAgent } from './tui-agent-config'
import {
  findTuiAgentProfile,
  interpolateTuiAgentProfileVariables,
  resolveTuiAgentBaseAgent,
  type TuiAgentProfileVariables
} from './tui-agent-profiles'
import { YOLO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'
import type { BuiltInTuiAgent, TuiAgent, TuiAgentProfile } from './types'

const UNSUPPORTED_TUI_AGENT_ARGS: Partial<Record<BuiltInTuiAgent, readonly string[]>> = {
  opencode: ['--dangerously-skip-permissions'],
  kilo: ['--dangerously-skip-permissions']
}

export const DEFAULT_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = YOLO_TUI_AGENT_ARGS

export const DEFAULT_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> =
  YOLO_TUI_AGENT_ENV

function argPattern(arg: string): RegExp {
  return new RegExp(`(^|\\s)${arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g')
}

export function hasUnsupportedTuiAgentArgs(agent: BuiltInTuiAgent, value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  return (UNSUPPORTED_TUI_AGENT_ARGS[agent] ?? []).some((arg) => argPattern(arg).test(value))
}

function sanitizeTuiAgentLaunchArgs(agent: BuiltInTuiAgent, args: string): string {
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
    if (!isBuiltInTuiAgent(agent) || typeof args !== 'string') {
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
  const baseAgent = isBuiltInTuiAgent(agent) ? agent : null
  return baseAgent ? (DEFAULT_TUI_AGENT_ARGS[baseAgent] ?? '') : ''
}

export function getTuiAgentDefaultEnv(agent: TuiAgent): Record<string, string> {
  const baseAgent = isBuiltInTuiAgent(agent) ? agent : null
  return baseAgent ? { ...DEFAULT_TUI_AGENT_ENV[baseAgent] } : {}
}

export function resolveTuiAgentLaunchArgs(
  agent: TuiAgent,
  configuredArgs: Partial<Record<TuiAgent, string>> | null | undefined,
  profiles?: readonly TuiAgentProfile[] | null,
  variables?: TuiAgentProfileVariables | null
): string {
  const profile = findTuiAgentProfile(agent, profiles)
  if (profile?.defaultArgs !== undefined) {
    return interpolateTuiAgentProfileVariables(profile.defaultArgs, variables)
  }
  if (
    configuredArgs &&
    Object.prototype.hasOwnProperty.call(configuredArgs, agent) &&
    typeof configuredArgs[agent] === 'string'
  ) {
    return interpolateTuiAgentProfileVariables(configuredArgs[agent] ?? '', variables)
  }
  const baseAgent = resolveTuiAgentBaseAgent(agent, profiles)
  return baseAgent ? getTuiAgentDefaultArgs(baseAgent) : ''
}

export function resolveTuiAgentLaunchEnv(
  agent: TuiAgent,
  configuredEnv: Partial<Record<TuiAgent, Record<string, string>>> | null | undefined,
  profiles?: readonly TuiAgentProfile[] | null,
  variables?: TuiAgentProfileVariables | null
): Record<string, string> {
  const profile = findTuiAgentProfile(agent, profiles)
  if (profile?.defaultEnv) {
    return Object.fromEntries(
      Object.entries(profile.defaultEnv).map(([key, value]) => [
        key,
        interpolateTuiAgentProfileVariables(value, variables)
      ])
    )
  }
  if (configuredEnv && Object.prototype.hasOwnProperty.call(configuredEnv, agent)) {
    return Object.fromEntries(
      Object.entries(configuredEnv[agent] ?? {}).map(([key, value]) => [
        key,
        interpolateTuiAgentProfileVariables(value, variables)
      ])
    )
  }
  const baseAgent = resolveTuiAgentBaseAgent(agent, profiles)
  return baseAgent ? getTuiAgentDefaultEnv(baseAgent) : {}
}

export function resolveTuiAgentLaunchCommandOverride(
  agent: TuiAgent,
  cmdOverrides: Partial<Record<TuiAgent, string>> | null | undefined,
  profiles?: readonly TuiAgentProfile[] | null,
  variables?: TuiAgentProfileVariables | null
): string | undefined {
  const profile = findTuiAgentProfile(agent, profiles)
  const value = profile?.cmdOverride ?? cmdOverrides?.[agent]
  if (!value?.trim()) {
    return undefined
  }
  return interpolateTuiAgentProfileVariables(value.trim(), variables)
}
