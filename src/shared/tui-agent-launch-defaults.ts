import { isTuiAgent } from './tui-agent-config'
import { YOLO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

const UNSUPPORTED_TUI_AGENT_ARGS: Partial<Record<TuiAgent, readonly string[]>> = {
  opencode: ['--dangerously-skip-permissions'],
  kilo: ['--dangerously-skip-permissions']
}

export const DEFAULT_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = YOLO_TUI_AGENT_ARGS

export const DEFAULT_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> =
  YOLO_TUI_AGENT_ENV

function argPattern(arg: string): RegExp {
  const tokens = arg
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(^|\\s)${tokens.join('\\s+')}(?=\\s|$)`, 'g')
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

/** Drop the agent's permission-bypass flag from a launch argument string.
 *  Why: a resume Orca cannot place in the directory the session actually belongs to must
 *  not also run unattended with prompts disabled — the agent has to ask first (STA-5804). */
function stripYoloTuiAgentLaunchValue(
  agent: TuiAgent,
  value: string,
  shell: AgentStartupShell = 'posix'
): string {
  const yoloArgs = YOLO_TUI_AGENT_ARGS[agent]
  if (!yoloArgs) {
    return value.trim()
  }
  const parsed = tokenizeStartupCommand(value, shell)
  if (!parsed.ok || parsed.spans.some((span) => span.divergesFromShell)) {
    return ''
  }
  // Why: the bypass form is a shell string too (`--allow "*"`), so a whitespace split would
  // compare `"*"` against the launch path's `*` and silently strip nothing. Parse both sides
  // the same way, and treat a bypass form this shell cannot model as unprovable-absent.
  const parsedYolo = tokenizeStartupCommand(yoloArgs, shell)
  if (
    !parsedYolo.ok ||
    parsedYolo.tokens.length === 0 ||
    parsedYolo.spans.some((span) => span.divergesFromShell)
  ) {
    return ''
  }
  const yoloTokens = parsedYolo.tokens
  const ranges: { start: number; end: number }[] = []
  for (let index = 0; index <= parsed.tokens.length - yoloTokens.length; index += 1) {
    if (yoloTokens.every((token, offset) => parsed.tokens[index + offset] === token)) {
      ranges.push({
        start: parsed.spans[index].start,
        end: parsed.spans[index + yoloTokens.length - 1].end
      })
      index += yoloTokens.length - 1
    }
  }
  let stripped = value
  for (const range of ranges.toReversed()) {
    stripped = `${stripped.slice(0, range.start)}${stripped.slice(range.end)}`
  }
  return stripped.trim()
}

export function stripYoloTuiAgentLaunchArgs(
  agent: TuiAgent,
  args: string,
  shell: AgentStartupShell = 'posix'
): string {
  return stripYoloTuiAgentLaunchValue(agent, args, shell)
}

export function stripYoloTuiAgentLaunchCommand(
  agent: TuiAgent,
  command: string,
  shell: AgentStartupShell
): string {
  return stripYoloTuiAgentLaunchValue(agent, command, shell)
}

/** Env counterpart of stripYoloTuiAgentLaunchArgs; removes only names the agent's own
 *  yolo profile sets, and only when the value still equals that profile's value. */
export function stripYoloTuiAgentLaunchEnv(
  agent: TuiAgent,
  env: Record<string, string>
): Record<string, string> {
  const yoloEnv = YOLO_TUI_AGENT_ENV[agent]
  if (!yoloEnv) {
    return { ...env }
  }
  const next: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (yoloEnv[name] === value) {
      continue
    }
    next[name] = value
  }
  return next
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
