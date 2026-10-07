import type { GlobalSettings } from './global-settings-types'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  PERMISSION_AGENT_IDS,
  resolveAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from './tui-agent-permissions'
import {
  bypassFlagBeside,
  classifyTypedAgentPermissions,
  resolveAgentPermissionPosture
} from './tui-agent-permission-args'
import type { TuiAgent } from './tui-agent'
import { resolveAgentLaunchGrammar, type AgentLaunchTarget } from './tui-agent-startup-shell'

const UNSUPPORTED_TUI_AGENT_ARGS: Partial<Record<TuiAgent, readonly string[]>> = {
  opencode: ['--dangerously-skip-permissions'],
  kilo: ['--dangerously-skip-permissions']
}

/** The settings slice that decides an agent's launch arguments and environment. */
export type AgentLaunchProfileSettings = Partial<
  Pick<
    GlobalSettings,
    'agentDefaultArgs' | 'agentDefaultEnv' | 'agentPermissionMode' | 'agentPermissionModeOverrides'
  >
>

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

/**
 * A stored profile's extra text, with an explicit entry for every agent that has a bypass flag.
 * Older builds read a missing entry as "launch with the bypass flag", so `''` keeps a downgrade Manual.
 */
export function normalizeStoredAgentLaunchArgs(value: unknown): Partial<Record<TuiAgent, string>> {
  const normalized = normalizeTuiAgentArgsRecord(value)
  for (const agent of PERMISSION_AGENT_IDS) {
    if (agent in YOLO_TUI_AGENT_ARGS && !Object.hasOwn(normalized, agent)) {
      normalized[agent] = ''
    }
  }
  return normalized
}

/** Environment counterpart of normalizeStoredAgentLaunchArgs, for env-driven bypass agents. */
export function normalizeStoredAgentLaunchEnv(
  value: unknown
): Partial<Record<TuiAgent, Record<string, string>>> {
  const normalized = normalizeTuiAgentEnvRecord(value)
  for (const agent of PERMISSION_AGENT_IDS) {
    if (agent in YOLO_TUI_AGENT_ENV && !Object.hasOwn(normalized, agent)) {
      normalized[agent] = {}
    }
  }
  return normalized
}

/**
 * The one place a permission mode becomes a CLI flag: the mode's flag, then the extra text, all
 * read with the shell at `target` launches with. Extra text that sets permissions itself decides
 * alone — a repeated or conflicting flag stops clap CLIs. Per-launch text replaces the configured
 * text but not the agent's effective mode: one whose configured Arguments ask (Codex
 * `-a on-request`) gets no flag, one in Yolo by alias does.
 */
export function resolveTuiAgentLaunchArgs(
  agent: TuiAgent,
  settings: AgentLaunchProfileSettings | null | undefined,
  target: AgentLaunchTarget,
  extraArgs?: string | null
): string {
  // `undefined` means the configured text; `null` means none for this launch.
  const extra = (
    extraArgs === undefined ? (settings?.agentDefaultArgs?.[agent] ?? '') : (extraArgs ?? '')
  ).trim()
  const shell = resolveAgentLaunchGrammar(target)
  if (
    !YOLO_TUI_AGENT_ARGS[agent] ||
    !resolveAgentPermissionPosture(agent, settings, target).effectiveBypass ||
    classifyTypedAgentPermissions(agent, { args: extra }, shell).kind !== 'none'
  ) {
    return extra
  }
  const bypassArg = bypassFlagBeside(agent, extra, shell)
  return extra ? `${bypassArg} ${extra}` : bypassArg
}

/** The launch environment for this agent: its permission mode's env, then the user's extra env. */
export function resolveTuiAgentLaunchEnv(
  agent: TuiAgent,
  settings: AgentLaunchProfileSettings | null | undefined
): Record<string, string> {
  const extra = settings?.agentDefaultEnv?.[agent] ?? {}
  const bypassEnv = YOLO_TUI_AGENT_ENV[agent]
  return bypassEnv && resolveAgentPermissionMode(agent, settings) === 'bypass'
    ? { ...bypassEnv, ...extra }
    : { ...extra }
}

/** Every agent's launch-ready arguments (flag inline): the shape paired clients exchange. */
export function composeTuiAgentLaunchArgsRecord(
  settings: AgentLaunchProfileSettings | null | undefined,
  target: AgentLaunchTarget
): Partial<Record<TuiAgent, string>> {
  const record: Partial<Record<TuiAgent, string>> = {}
  for (const agent of Object.keys(TUI_AGENT_CONFIG)) {
    if (isTuiAgent(agent)) {
      record[agent] = resolveTuiAgentLaunchArgs(agent, settings, target)
    }
  }
  return record
}

/** Every agent's launch-ready environment; see composeTuiAgentLaunchArgsRecord. */
export function composeTuiAgentLaunchEnvRecord(
  settings: AgentLaunchProfileSettings | null | undefined
): Partial<Record<TuiAgent, Record<string, string>>> {
  const record: Partial<Record<TuiAgent, Record<string, string>>> = {}
  for (const agent of Object.keys(TUI_AGENT_CONFIG)) {
    if (isTuiAgent(agent)) {
      record[agent] = resolveTuiAgentLaunchEnv(agent, settings)
    }
  }
  return record
}

/** Reads a launch-ready record (flag inline), never stored settings; a missing key meant the bypass flag. */
export function resolveComposedTuiAgentLaunchArgs(
  agent: TuiAgent,
  record: Partial<Record<TuiAgent, string>> | null | undefined
): string {
  if (record && Object.hasOwn(record, agent) && typeof record[agent] === 'string') {
    return record[agent] ?? ''
  }
  return YOLO_TUI_AGENT_ARGS[agent] ?? ''
}

/** Environment counterpart of resolveComposedTuiAgentLaunchArgs. */
export function resolveComposedTuiAgentLaunchEnv(
  agent: TuiAgent,
  record: Partial<Record<TuiAgent, Record<string, string>>> | null | undefined
): Record<string, string> {
  if (record && Object.hasOwn(record, agent)) {
    return { ...record[agent] }
  }
  return { ...YOLO_TUI_AGENT_ENV[agent] }
}
